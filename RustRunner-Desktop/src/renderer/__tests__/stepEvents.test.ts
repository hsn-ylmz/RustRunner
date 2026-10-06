import { describe, it, expect } from 'vitest';
import {
  applyRunEvent,
  buildStatusRows,
  describeSkipReason,
  resolveBaseStepId,
  rollupNodeStatuses,
  summarizeRows,
  toStepEvent,
  type StepEvent,
  type StepRuns,
} from '../stepEvents';

const fold = (events: StepEvent[], runs: StepRuns = {}) =>
  events.reduce((acc, e) => applyRunEvent(acc, e), runs);

describe('toStepEvent', () => {
  const at = { v: 1 as const, ts: '2026-01-01T00:00:00.000Z' };

  it('maps the first attempt to a start and later attempts to attempts', () => {
    expect(
      toStepEvent({ ...at, event: 'step_started', step: 'align', attempt: 1, max_attempts: 3 })
    ).toEqual({ kind: 'start', stepId: 'align', attempt: 1, maxAttempts: 3 });
    expect(
      toStepEvent({ ...at, event: 'step_started', step: 'align', attempt: 2, max_attempts: 3 })
    ).toEqual({ kind: 'attempt', stepId: 'align', attempt: 2, maxAttempts: 3 });
  });

  it('maps retries, outcomes, skips and checks', () => {
    expect(
      toStepEvent({
        ...at,
        event: 'step_retrying',
        step: 'align',
        attempt: 1,
        max_attempts: 3,
        delay_secs: 5,
        reason: 'exit 2',
      })
    ).toEqual({ kind: 'retry', stepId: 'align', attempt: 1, maxAttempts: 3, delaySecs: 5 });
    expect(toStepEvent({ ...at, event: 'step_succeeded', step: 'align', attempts: 1 })).toEqual({
      kind: 'done',
      stepId: 'align',
    });
    expect(
      toStepEvent({ ...at, event: 'step_failed', step: 'align', reason: 'exit 1', attempts: 1 })
    ).toEqual({ kind: 'failed', stepId: 'align', message: 'exit 1' });
    expect(
      toStepEvent({ ...at, event: 'step_skipped', step: 'align_a', reason: 'earlier run' })
    ).toEqual({ kind: 'skipped', stepId: 'align_a', reason: 'earlier run' });
    expect(
      toStepEvent({
        ...at,
        event: 'check_failed',
        step: 'align',
        kind: 'min_lines',
        blocking: false,
        message: 'too short',
      })
    ).toEqual({ kind: 'check', stepId: 'align', blocking: false, message: 'too short' });
  });

  it('returns null for run-level events', () => {
    expect(
      toStepEvent({
        ...at,
        event: 'run_started',
        workflow: 'demo',
        run_id: 'r',
        steps: ['align'],
        dry_run: false,
      })
    ).toBeNull();
    expect(
      toStepEvent({
        ...at,
        event: 'run_finished',
        status: 'succeeded',
        summary: {
          total: 1,
          succeeded: 1,
          failed: 0,
          skipped: 0,
          retried: 0,
          check_warnings: 0,
          duration_secs: 0.1,
        },
      })
    ).toBeNull();
  });
});

describe('applyRunEvent', () => {
  it('walks a step through running, retrying and succeeded', () => {
    let runs = fold([{ kind: 'start', stepId: 'a' }]);
    expect(runs.a.state).toBe('running');
    runs = fold([{ kind: 'retry', stepId: 'a', attempt: 1, maxAttempts: 3 }], runs);
    expect(runs.a).toMatchObject({ state: 'retrying', attempt: 1, maxAttempts: 3 });
    runs = fold([{ kind: 'attempt', stepId: 'a', attempt: 2, maxAttempts: 3 }], runs);
    expect(runs.a).toMatchObject({ state: 'running', attempt: 2 });
    runs = fold([{ kind: 'done', stepId: 'a' }], runs);
    expect(runs.a.state).toBe('succeeded');
    expect(runs.a.attempt).toBe(2);
  });

  it('records failures with their message and skipped steps', () => {
    const runs = fold([
      { kind: 'skipped', stepId: 'a' },
      { kind: 'start', stepId: 'b' },
      { kind: 'failed', stepId: 'b', message: 'boom' },
    ]);
    expect(runs.a.state).toBe('skipped');
    expect(runs.b).toMatchObject({ state: 'failed', message: 'boom' });
  });
});

describe('retrying with attempt N/M', () => {
  it('shows the failed attempt and delay while retrying, then the next attempt', () => {
    let runs = fold([
      { kind: 'start', stepId: 'a', attempt: 1, maxAttempts: 3 },
      { kind: 'retry', stepId: 'a', attempt: 1, maxAttempts: 3, delaySecs: 5 },
    ]);
    expect(runs.a).toMatchObject({ state: 'retrying', attempt: 1, maxAttempts: 3, delaySecs: 5 });
    expect(rollupNodeStatuses(runs, ['a']).a).toMatchObject({
      state: 'retrying',
      attempt: 1,
      maxAttempts: 3,
    });
    const rows = buildStatusRows(runs, [{ stepId: 'a', label: 'A' }], 'active');
    expect(rows[0]).toMatchObject({ state: 'retrying', attempt: 1, maxAttempts: 3, delaySecs: 5 });

    runs = fold([{ kind: 'attempt', stepId: 'a', attempt: 2, maxAttempts: 3 }], runs);
    expect(runs.a).toMatchObject({ state: 'running', attempt: 2, delaySecs: undefined });
  });

  it('keeps non-blocking check warnings on a step that goes on, and ignores blocking ones', () => {
    let runs = fold([
      { kind: 'start', stepId: 'a' },
      { kind: 'check', stepId: 'a', blocking: false, message: 'few lines' },
    ]);
    expect(runs.a).toMatchObject({ state: 'running', warnings: ['few lines'] });
    runs = fold([{ kind: 'done', stepId: 'a' }], runs);
    expect(runs.a).toMatchObject({ state: 'succeeded', warnings: ['few lines'] });

    const blocked = fold([
      { kind: 'start', stepId: 'b' },
      { kind: 'check', stepId: 'b', blocking: true, message: 'empty' },
      { kind: 'failed', stepId: 'b', message: 'output check failed: empty' },
    ]);
    expect(blocked.b.warnings).toBeUndefined();
    expect(blocked.b.state).toBe('failed');
  });

  it('keeps the reason of a skipped step', () => {
    const runs = fold([{ kind: 'skipped', stepId: 'a', reason: 'completed in an earlier run' }]);
    expect(runs.a).toEqual({ state: 'skipped', message: 'completed in an earlier run' });
  });
});

describe('up-to-date skips', () => {
  it('turns the engine reason into readable text and leaves others alone', () => {
    expect(describeSkipReason('up_to_date')).toMatch(/^up to date/);
    expect(describeSkipReason("not run: step 'a' failed")).toBe("not run: step 'a' failed");
    expect(describeSkipReason(undefined)).toBeUndefined();
  });

  it('shows an up_to_date skip as such in the status', () => {
    const runs = fold([{ kind: 'skipped', stepId: 'a', reason: 'up_to_date' }]);
    expect(runs.a.state).toBe('skipped');
    expect(runs.a.message).toBe(describeSkipReason('up_to_date'));
  });
});

describe('rollupNodeStatuses', () => {
  const base = ['align', 'sort'];

  it('rolls wildcard instances up to their node', () => {
    const runs = fold([
      { kind: 'start', stepId: 'align_a' },
      { kind: 'start', stepId: 'align_b' },
      { kind: 'done', stepId: 'align_a' },
    ]);
    expect(rollupNodeStatuses(runs, base).align).toMatchObject({
      state: 'running',
      finished: 1,
      total: 2,
    });
    const all = fold([{ kind: 'done', stepId: 'align_b' }], runs);
    expect(rollupNodeStatuses(all, base).align).toMatchObject({ state: 'succeeded', finished: 2 });
  });

  it('prefers failed over retrying over running, and keeps the first message', () => {
    const runs = fold([
      { kind: 'start', stepId: 'align_a' },
      { kind: 'retry', stepId: 'align_b', attempt: 1, maxAttempts: 2 },
    ]);
    expect(rollupNodeStatuses(runs, base).align.state).toBe('retrying');
    const failed = fold([{ kind: 'failed', stepId: 'align_a', message: 'x' }], runs);
    expect(rollupNodeStatuses(failed, base).align).toMatchObject({ state: 'failed', message: 'x' });
  });

  it('shows skipped only when every instance was skipped', () => {
    const skipped = fold([
      { kind: 'skipped', stepId: 'sort_a' },
      { kind: 'skipped', stepId: 'sort_b' },
    ]);
    expect(rollupNodeStatuses(skipped, base).sort.state).toBe('skipped');
    const mixed = fold([{ kind: 'done', stepId: 'sort_c' }], skipped);
    expect(rollupNodeStatuses(mixed, base).sort.state).toBe('succeeded');
  });

  it('ignores engine steps it cannot attribute and omits unseen nodes', () => {
    const out = rollupNodeStatuses(fold([{ kind: 'start', stepId: 'ghost' }]), base);
    expect(out).toEqual({});
  });
});

describe('buildStatusRows', () => {
  const nodes = [
    { stepId: 'align', label: 'Align' },
    { stepId: 'sort', label: 'Sort' },
  ];

  it('shows nothing before a run', () => {
    expect(buildStatusRows({}, nodes, 'none')).toEqual([]);
  });

  it('names each per-file run by its file, and a plain step by nothing extra', () => {
    const runs = fold([
      { kind: 'start', stepId: 'align_sample_1' },
      { kind: 'start', stepId: 'sort' },
    ]);
    const rows = buildStatusRows(runs, nodes, 'active');
    expect(rows.map((r) => [r.label, r.instance])).toEqual([
      ['Align', 'sample_1'],
      ['Sort', undefined],
    ]);
  });

  it('lists unstarted nodes as pending while the run is active', () => {
    const runs = fold([{ kind: 'start', stepId: 'align' }]);
    const rows = buildStatusRows(runs, nodes, 'active');
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['align', 'running'],
      ['sort', 'pending'],
    ]);
  });

  it('marks nodes that never ran as skipped once the run has ended', () => {
    const runs = fold([
      { kind: 'start', stepId: 'align_a' },
      { kind: 'start', stepId: 'align_b' },
      { kind: 'failed', stepId: 'align_a', message: 'bad' },
    ]);
    const rows = buildStatusRows(runs, nodes, 'ended');
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['align_a', 'failed'],
      ['align_b', 'running'],
      ['sort', 'skipped'],
    ]);
    expect(rows[0].label).toBe('Align');
    expect(summarizeRows(rows)).toMatchObject({ failed: 1, running: 1, skipped: 1, pending: 0 });
  });
});

describe('resolveBaseStepId', () => {
  it('prefers the longest base id', () => {
    expect(resolveBaseStepId('align_sorted_a', ['align', 'align_sorted'])).toBe('align_sorted');
    expect(resolveBaseStepId('other', ['align'])).toBeNull();
  });
});

describe('mocked steps', () => {
  const at = { v: 1 as const, ts: '2026-01-01T00:00:00.000Z' };

  it('carries the mocked flag of step_succeeded and leaves normal steps unchanged', () => {
    expect(
      toStepEvent({ ...at, event: 'step_succeeded', step: 'a', attempts: 1, mocked: true })
    ).toEqual({ kind: 'done', stepId: 'a', mocked: true });
    expect(toStepEvent({ ...at, event: 'step_succeeded', step: 'a', attempts: 1 })).toEqual({
      kind: 'done',
      stepId: 'a',
    });
  });

  it('marks the run, the node rollup and the status row as mocked', () => {
    const runs = fold([
      { kind: 'start', stepId: 'a', attempt: 1, maxAttempts: 1 },
      { kind: 'done', stepId: 'a', mocked: true },
      { kind: 'start', stepId: 'b', attempt: 1, maxAttempts: 1 },
      { kind: 'done', stepId: 'b' },
    ]);
    expect(runs.a.mocked).toBe(true);
    expect(runs.b.mocked).toBeUndefined();
    const nodes = rollupNodeStatuses(runs, ['a', 'b']);
    expect(nodes.a.mocked).toBe(true);
    expect(nodes.b.mocked).toBeUndefined();
    const rows = buildStatusRows(
      runs,
      [
        { stepId: 'a', label: 'A' },
        { stepId: 'b', label: 'B' },
      ],
      'ended'
    );
    expect(rows.map((r) => r.mocked)).toEqual([true, undefined]);
  });

  it('forgets the mark when the step runs for real next time', () => {
    const runs = fold([
      { kind: 'done', stepId: 'a', mocked: true },
      { kind: 'start', stepId: 'a', attempt: 1, maxAttempts: 1 },
      { kind: 'done', stepId: 'a' },
    ]);
    expect(runs.a.mocked).toBeUndefined();
  });
});
