import { describe, it, expect } from 'vitest';
import {
  EVENT_PREFIX,
  EngineOutputSplitter,
  parseEngineLine,
  type EngineEvent,
} from './engineEvents';

const line = (body: Record<string, unknown>, v: number = 1) =>
  EVENT_PREFIX + JSON.stringify({ v, ts: '2026-01-01T00:00:00.000Z', ...body });

const SUMMARY = {
  total: 2,
  succeeded: 1,
  failed: 1,
  skipped: 0,
  retried: 1,
  check_warnings: 0,
  duration_secs: 1.5,
};

describe('parseEngineLine', () => {
  it('parses every event of the v1 schema', () => {
    const bodies: Record<string, unknown>[] = [
      { event: 'run_started', workflow: 'demo', run_id: 'r1', steps: ['a', 'b'], dry_run: false },
      { event: 'step_started', step: 'a', attempt: 1, max_attempts: 3 },
      {
        event: 'step_retrying',
        step: 'a',
        attempt: 1,
        max_attempts: 3,
        delay_secs: 5,
        reason: 'exit 1',
      },
      { event: 'step_succeeded', step: 'a', attempts: 2 },
      { event: 'step_failed', step: 'b', reason: 'boom', attempts: 1 },
      { event: 'step_skipped', step: 'c', reason: 'completed in an earlier run' },
      { event: 'check_failed', step: 'b', kind: 'non_empty', blocking: true, message: 'is empty' },
      { event: 'run_finished', status: 'failed', summary: { ...SUMMARY, error: 'x' } },
      {
        event: 'run_finished',
        status: 'succeeded',
        summary: SUMMARY,
        report: '/work/.rustrunner/runs/r1/report.html',
      },
    ];
    for (const body of bodies) {
      const parsed = parseEngineLine(line(body));
      expect(parsed.type, String(body.event)).toBe('event');
      if (parsed.type === 'event') expect(parsed.event).toMatchObject(body);
    }
  });

  it('treats ordinary log lines as text', () => {
    expect(parseEngineLine('Starting step: align')).toEqual({ type: 'text' });
    expect(parseEngineLine('')).toEqual({ type: 'text' });
    expect(parseEngineLine(`  ${EVENT_PREFIX}{}`)).toEqual({ type: 'text' });
  });

  it('keeps malformed event lines visible as text', () => {
    expect(parseEngineLine(EVENT_PREFIX + '{not json')).toEqual({ type: 'text' });
    expect(parseEngineLine(EVENT_PREFIX + '[1,2]')).toEqual({ type: 'text' });
    expect(parseEngineLine(EVENT_PREFIX + '{"event":"step_started"}')).toEqual({ type: 'text' });
    // Known event, wrong field types.
    expect(
      parseEngineLine(line({ event: 'step_started', step: 'a', attempt: '1', max_attempts: 2 }))
    ).toEqual({ type: 'text' });
    expect(
      parseEngineLine(line({ event: 'run_finished', status: 'weird', summary: SUMMARY }))
    ).toEqual({ type: 'text' });
    expect(parseEngineLine(line({ event: 'run_finished', status: 'failed', summary: {} }))).toEqual({
      type: 'text',
    });
    // The optional report path must be text when present.
    expect(
      parseEngineLine(line({ event: 'run_finished', status: 'failed', summary: SUMMARY, report: 7 }))
    ).toEqual({ type: 'text' });
  });

  it('drops events it does not know and events of another schema version', () => {
    expect(parseEngineLine(line({ event: 'step_paused', step: 'a' }))).toEqual({ type: 'ignored' });
    expect(parseEngineLine(line({ event: 'step_started', step: 'a', attempt: 1, max_attempts: 1 }, 2))).toEqual({
      type: 'ignored',
    });
    // Prototype keys are not event names.
    expect(parseEngineLine(line({ event: 'constructor' }))).toEqual({ type: 'ignored' });
  });

  it('ignores fields it does not know (additive schema changes)', () => {
    const parsed = parseEngineLine(
      line({ event: 'step_succeeded', step: 'a', attempts: 1, new_field: { x: 1 } })
    );
    expect(parsed.type).toBe('event');
  });
});

describe('EngineOutputSplitter', () => {
  const started = line({ event: 'step_started', step: 'a', attempt: 1, max_attempts: 1 });
  const done = line({ event: 'step_succeeded', step: 'a', attempts: 1 });

  it('separates events from log text and keeps the text verbatim', () => {
    const s = new EngineOutputSplitter();
    const out = s.push(`log one\n${started}\nlog two\n${done}\n`);
    expect(out.text).toBe('log one\nlog two\n');
    expect(out.events.map((e: EngineEvent) => e.event)).toEqual(['step_started', 'step_succeeded']);
  });

  it('holds back an incomplete line until its newline arrives', () => {
    const s = new EngineOutputSplitter();
    const cut = Math.floor(started.length / 2);
    expect(s.push(`first\n${started.slice(0, cut)}`)).toMatchObject({ text: 'first\n', events: [] });
    const rest = s.push(`${started.slice(cut)}\nafter`);
    expect(rest.events).toHaveLength(1);
    expect(rest.text).toBe('');
    expect(s.flush()).toEqual({ events: [], text: 'after' });
  });

  it('flush releases a final line that had no newline, including an event', () => {
    const s = new EngineOutputSplitter();
    expect(s.push(done)).toEqual({ events: [], text: '' });
    expect(s.flush().events.map((e: EngineEvent) => e.event)).toEqual(['step_succeeded']);
    expect(s.flush()).toEqual({ events: [], text: '' });
  });

  it('handles CRLF line endings and blank lines', () => {
    const s = new EngineOutputSplitter();
    const out = s.push(`${started}\r\n\r\nplain\r\n`);
    expect(out.events).toHaveLength(1);
    expect(out.text).toBe('\r\nplain\r\n');
  });

  it('decodes byte chunks as one UTF-8 stream, even when a character is split', () => {
    const s = new EngineOutputSplitter();
    const named = line({ event: 'step_succeeded', step: 'örnek_ğ', attempts: 1 });
    const bytes = new TextEncoder().encode(`${named}\nlog é\n`);
    // Cut inside the two-byte "ö".
    const cut = bytes.indexOf(0xc3) + 1;
    const first = s.push(bytes.subarray(0, cut));
    const second = s.push(bytes.subarray(cut));
    expect(first).toEqual({ events: [], text: '' });
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ event: 'step_succeeded', step: 'örnek_ğ' });
    expect(second.text).toBe('log é\n');
  });

  it('flush turns a dangling partial character into a replacement character', () => {
    const s = new EngineOutputSplitter();
    s.push(new Uint8Array([0x61, 0xc3]));
    expect(s.flush()).toEqual({ events: [], text: 'a\ufffd' });
  });

  it('keeps a malformed event line in the text', () => {
    const s = new EngineOutputSplitter();
    const bad = `${EVENT_PREFIX}{oops`;
    expect(s.push(`${bad}\n`)).toEqual({ events: [], text: `${bad}\n` });
  });
});

describe('mocked steps', () => {
  it('accepts the additive mocked fields and rejects wrong types', () => {
    const ok = parseEngineLine(line({ event: 'step_succeeded', step: 'a', attempts: 1, mocked: true }));
    expect(ok.type).toBe('event');
    if (ok.type === 'event' && ok.event.event === 'step_succeeded') {
      expect(ok.event.mocked).toBe(true);
    }
    const summary = parseEngineLine(
      line({ event: 'run_finished', status: 'succeeded', summary: { ...SUMMARY, mocked: 1 } })
    );
    expect(summary.type).toBe('event');
    // A malformed value is kept as log text, like any malformed event.
    expect(
      parseEngineLine(line({ event: 'step_succeeded', step: 'a', attempts: 1, mocked: 'yes' })).type
    ).toBe('text');
  });
});
