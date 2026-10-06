import { describe, expect, it } from 'vitest';
import {
  PENDING_STATUS,
  buildFailureCard,
  describeRunResult,
  nodeStatusLine,
  plainFailure,
  sectionToEdit,
  stateView,
  type RunResult,
} from '../runFeedback';
import { applyRunEvent, rollupNodeStatuses, type StepEvent, type StepRuns } from '../stepEvents';

const fold = (events: StepEvent[]): StepRuns => events.reduce(applyRunEvent, {} as StepRuns);

describe('stateView', () => {
  it('gives every state an icon and a word', () => {
    for (const state of ['pending', 'running', 'retrying', 'succeeded', 'failed', 'skipped'] as const) {
      const view = stateView(state);
      expect(view.icon).toBeTruthy();
      expect(view.label.length).toBeGreaterThan(2);
    }
  });

  it('refines skipped to up to date and succeeded to mocked, only with the flag', () => {
    expect(stateView('skipped').label).toBe('Skipped');
    expect(stateView('skipped', { upToDate: true }).label).toBe('Up to date');
    expect(stateView('succeeded').label).toBe('Done');
    expect(stateView('succeeded', { mocked: true }).label).toBe('Mocked');
    expect(stateView('failed', { mocked: true, upToDate: true }).label).toBe('Failed');
  });
});

describe('nodeStatusLine', () => {
  it('names the next attempt while retrying', () => {
    const status = { state: 'retrying', finished: 0, total: 1, attempt: 1, maxAttempts: 3 } as const;
    expect(nodeStatusLine(status)).toBe('Retrying, attempt 2 of 3');
  });

  it('never claims an attempt beyond the last', () => {
    const status = { state: 'retrying', finished: 0, total: 1, attempt: 3, maxAttempts: 3 } as const;
    expect(nodeStatusLine(status)).toBe('Retrying, attempt 3 of 3');
  });

  it('counts files for a step that expanded into many', () => {
    expect(nodeStatusLine({ state: 'running', finished: 2, total: 5 })).toBe('Running, 2 of 5 files');
    expect(nodeStatusLine({ state: 'running', finished: 0, total: 1 })).toBe('Running');
  });

  it('reads waiting, up to date and mocked', () => {
    expect(nodeStatusLine(PENDING_STATUS)).toBe('Waiting');
    expect(nodeStatusLine({ state: 'skipped', finished: 1, total: 1, upToDate: true })).toBe('Up to date');
    expect(nodeStatusLine({ state: 'succeeded', finished: 1, total: 1, mocked: true })).toBe('Mocked');
  });
});

describe('describeRunResult', () => {
  const summary = {
    total: 5,
    succeeded: 3,
    failed: 1,
    skipped: 1,
    retried: 0,
    check_warnings: 0,
    duration_secs: 4.2,
  };
  const result = (over: Partial<RunResult> = {}): RunResult => ({ status: 'succeeded', summary, ...over });

  it('summarises duration and counts', () => {
    const view = describeRunResult(result());
    expect(view.title).toBe('Run succeeded');
    expect(view.tone).toBe('success');
    expect(view.detail).toBe('4.2 s, 3 succeeded, 1 failed, 1 skipped of 5 steps');
  });

  it('says dry run for a dry run and stopped for a stop', () => {
    expect(describeRunResult(result(), true).title).toBe('Dry run succeeded');
    expect(describeRunResult(result({ status: 'stopped' })).tone).toBe('neutral');
  });

  it('marks a failure and carries the engine error', () => {
    const view = describeRunResult(
      result({ status: 'failed', summary: { ...summary, error: ' step "a" failed ' } })
    );
    expect(view.tone).toBe('danger');
    expect(view.icon).toBe('x');
    expect(view.error).toBe('step "a" failed');
  });

  it('lists retries, warnings and mocked steps as notes only when present', () => {
    expect(describeRunResult(result()).notes).toEqual([]);
    const notes = describeRunResult(
      result({ summary: { ...summary, retried: 1, check_warnings: 2, mocked: 1 } })
    ).notes;
    expect(notes).toEqual([
      '1 step needed a retry',
      '2 check warnings',
      '1 step mocked, tools not run',
    ]);
  });

  it('uses the singular for one step', () => {
    const view = describeRunResult(
      result({ summary: { ...summary, total: 1, succeeded: 1, failed: 0, skipped: 0 } })
    );
    expect(view.detail).toBe('4.2 s, 1 succeeded of 1 step');
  });
});

describe('plainFailure', () => {
  it('turns engine boilerplate into a sentence', () => {
    expect(plainFailure("Step 'x' failed. See logs for details.")).toBe('The command ended with an error.');
    expect(plainFailure("Step 'x' timed out after 5s and was killed.")).toContain('time limit');
    expect(plainFailure('output check failed: empty.txt is empty')).toContain('did not pass a check');
    expect(plainFailure(undefined)).toBe('The command ended with an error.');
  });

  it('keeps a message it does not recognise', () => {
    expect(plainFailure('missing input a.txt')).toBe('missing input a.txt');
  });
});

describe('buildFailureCard', () => {
  const nodes = [
    { stepId: 'make', label: 'Make' },
    { stepId: 'align', label: 'Align' },
    { stepId: 'count', label: 'Count' },
  ];
  const logs = [
    'Starting step: align',
    "[ERROR] Step 'align' failed with exit code: Some(2)",
    '[ERROR] stderr:',
    'bwa: cannot open index',
    'check the reference path',
    'Workflow failed',
  ];

  it('is null when nothing failed', () => {
    const runs = fold([{ kind: 'start', stepId: 'make' }, { kind: 'done', stepId: 'make' }]);
    expect(buildFailureCard(runs, nodes, logs)).toBeNull();
  });

  it('names the step, the reason and the last stderr lines', () => {
    const runs = fold([
      { kind: 'start', stepId: 'make' },
      { kind: 'done', stepId: 'make' },
      { kind: 'start', stepId: 'align' },
      { kind: 'failed', stepId: 'align', message: "Step 'align' failed. See logs for details." },
      { kind: 'skipped', stepId: 'count', reason: 'upstream failed' },
    ]);
    const card = buildFailureCard(runs, nodes, logs)!;
    expect(card.headline).toBe('"Align" failed');
    expect(card.what).toBe('The command ended with an error.');
    expect(card.stderr).toEqual(['bwa: cannot open index', 'check the reference path']);
    expect(card.notRun).toBe(1);
    expect(card.check).toBeUndefined();
  });

  it('does not count up-to-date steps as not run', () => {
    const runs = fold([
      { kind: 'skipped', stepId: 'make', reason: 'up_to_date' },
      { kind: 'start', stepId: 'align' },
      { kind: 'failed', stepId: 'align', message: 'x' },
    ]);
    expect(buildFailureCard(runs, nodes, [])!.notRun).toBe(0);
  });

  it('carries the blocking check that failed the step', () => {
    const runs = fold([
      { kind: 'start', stepId: 'make' },
      { kind: 'check', stepId: 'make', blocking: true, message: 'empty.txt is empty' },
      { kind: 'failed', stepId: 'make', message: 'output check failed: empty.txt is empty' },
    ]);
    const card = buildFailureCard(runs, nodes, [])!;
    expect(card.check).toBe('empty.txt is empty');
    expect(card.what).toContain('did not pass a check');
    expect(card.stderr).toEqual([]);
    expect(sectionToEdit(card)).toBe('checks');
  });

  it('finds the failed instance of a step that expanded per file', () => {
    const runs = fold([
      { kind: 'done', stepId: 'align_a' },
      { kind: 'start', stepId: 'align_b' },
      { kind: 'failed', stepId: 'align_b', message: 'x' },
    ]);
    const card = buildFailureCard(runs, nodes, [
      "[ERROR] Step 'align_b' failed with exit code: Some(1)",
      '[ERROR] stderr:',
      'boom',
    ])!;
    expect(card.engineId).toBe('align_b');
    expect(card.nodeStepId).toBe('align');
    expect(card.stderr).toEqual(['boom']);
  });

  it('rolls the failure and its check up on the node', () => {
    const runs = fold([
      { kind: 'check', stepId: 'make', blocking: true, message: 'm' },
      { kind: 'failed', stepId: 'make', message: 'output check failed: m' },
    ]);
    const status = rollupNodeStatuses(runs, ['make'])['make'];
    expect(status.failedCheck).toBe('m');
    expect(status.failedStepId).toBe('make');
  });
});

describe('sectionToEdit', () => {
  it('sends a timeout to Reliability and anything else to Advanced', () => {
    expect(sectionToEdit({ what: 'The step took longer than its time limit and was stopped.' })).toBe('reliability');
    expect(sectionToEdit({ what: 'The command ended with an error.' })).toBe('advanced');
  });
});
