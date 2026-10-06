import { describe, expect, it } from 'vitest';
import { RUN_TOOLTIPS, describeRunState, type RunStateInput } from '../runState';

const base: RunStateInput = { executionState: 'idle', dryRun: false, outcome: null, finished: 0, total: 3 };

describe('describeRunState', () => {
  it('is Ready before any run', () => {
    expect(describeRunState(base)).toMatchObject({ label: 'Ready', tone: 'neutral' });
  });

  it('shows progress while running and holds on pause', () => {
    expect(describeRunState({ ...base, executionState: 'running', finished: 1 }).label).toBe(
      'Running, 1 of 3 steps'
    );
    expect(describeRunState({ ...base, executionState: 'running', total: 0 }).label).toBe('Running');
    expect(describeRunState({ ...base, executionState: 'paused' })).toMatchObject({
      label: 'Paused',
      tone: 'warning',
    });
  });

  it('says how the last run ended, with an icon besides colour', () => {
    expect(describeRunState({ ...base, outcome: 'success' })).toMatchObject({ tone: 'success', icon: 'check' });
    expect(describeRunState({ ...base, outcome: 'failed' })).toMatchObject({ tone: 'danger', icon: 'x' });
    expect(describeRunState({ ...base, outcome: 'stopped' }).label).toBe('Last run stopped');
  });

  it('a dry run in flight takes over the idle state', () => {
    expect(describeRunState({ ...base, dryRun: true, outcome: 'failed' }).label).toBe('Checking (dry run)');
  });
});

describe('RUN_TOOLTIPS', () => {
  it('is one sentence per control', () => {
    for (const text of Object.values(RUN_TOOLTIPS)) {
      expect(text.endsWith('.')).toBe(true);
      expect(text.split('. ').length).toBeLessThanOrEqual(2);
    }
  });
});
