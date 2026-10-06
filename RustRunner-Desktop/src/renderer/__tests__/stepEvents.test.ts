import { describe, it, expect } from 'vitest';
import {
  applyRunEvent,
  buildStatusRows,
  parseStepEvent,
  resolveBaseStepId,
  rollupNodeStatuses,
  summarizeRows,
  type StepEvent,
  type StepRuns,
} from '../stepEvents';

const fold = (events: StepEvent[], runs: StepRuns = {}) =>
  events.reduce((acc, e) => applyRunEvent(acc, e), runs);

describe('parseStepEvent', () => {
  it('recognizes the engine lines that already drove the canvas', () => {
    expect(parseStepEvent('Starting step: align')).toEqual({ kind: 'start', stepId: 'align' });
    expect(parseStepEvent("Step 'align' completed successfully")).toEqual({
      kind: 'done',
      stepId: 'align',
    });
    expect(parseStepEvent("[ERROR] Step 'align' failed: exit 1")).toEqual({
      kind: 'failed',
      stepId: 'align',
      message: 'exit 1',
    });
    expect(parseStepEvent('[DRY RUN] Step: align')).toEqual({ kind: 'done', stepId: 'align' });
  });

  it('recognizes retries, attempts and skipped steps', () => {
    expect(
      parseStepEvent("[WARN] Step 'align': attempt 1/3 failed (exit status 2); will retry")
    ).toEqual({ kind: 'retry', stepId: 'align', attempt: 1, maxAttempts: 3 });
    expect(parseStepEvent("Step 'align': attempt 2/3")).toEqual({
      kind: 'attempt',
      stepId: 'align',
      attempt: 2,
      maxAttempts: 3,
    });
    expect(parseStepEvent('Skipping previously completed step: align_a')).toEqual({
      kind: 'skipped',
      stepId: 'align_a',
    });
  });

  it('ignores unrelated lines, including a final-attempt failure warning', () => {
    expect(parseStepEvent('')).toBeNull();
    expect(parseStepEvent('some tool output')).toBeNull();
    expect(parseStepEvent("Step 'align' succeeded on attempt 2/3")).toBeNull();
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
