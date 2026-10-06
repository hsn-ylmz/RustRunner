import { describe, it, expect } from 'vitest';
import { describeResume, type ResumeInfo } from '../resume';

const info = (patch: Partial<ResumeInfo> = {}): ResumeInfo => ({
  canResume: true,
  completedCount: 3,
  failedStep: null,
  savedAt: 1000,
  workflowName: null,
  workflowVersion: null,
  ...patch,
});

describe('describeResume', () => {
  const fmt = () => 'T';

  it('asks for a working directory first', () => {
    expect(describeResume(null, false, fmt)).toMatch(/working directory/);
  });

  it('says so when nothing is saved', () => {
    expect(describeResume(null, true, fmt)).toMatch(/No saved run/);
    expect(describeResume(info({ canResume: false }), true, fmt)).toMatch(/No saved run/);
  });

  it('summarizes a saved run', () => {
    expect(describeResume(info(), true, fmt)).toBe(
      'Continue the last run: 3 steps already finished, saved T. Finished steps are skipped.'
    );
    const failed = describeResume(info({ completedCount: 1, failedStep: 'sort', savedAt: null }), true, fmt);
    expect(failed).toContain('1 step already finished');
    expect(failed).toContain('stopped at "sort"');
    expect(failed).not.toContain('saved');
  });
});
