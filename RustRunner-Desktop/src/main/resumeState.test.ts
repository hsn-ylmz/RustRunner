import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  NO_RESUME_INFO,
  parseResumeInfo,
  readResumeInfo,
  stateFilePath,
  workflowFileStem,
} from './resumeState';

describe('workflowFileStem', () => {
  it('slugifies the workflow name', () => {
    expect(workflowFileStem('RNA-seq QC!')).toBe('rna_seq_qc');
    expect(workflowFileStem('  Café run 2 ')).toBe('caf_run_2');
  });
  it('never yields an empty or path-like stem', () => {
    expect(workflowFileStem(undefined)).toBe('workflow');
    expect(workflowFileStem('!!!')).toBe('workflow');
    expect(workflowFileStem('../../etc/passwd')).toBe('etc_passwd');
    expect(workflowFileStem('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('parseResumeInfo', () => {
  const state = {
    workflow_path: '/tmp/x/rna.yaml',
    completed_steps: ['a', 'b'],
    failed_step: 'c',
    timestamp: { secs_since_epoch: 1700000000, nanos_since_epoch: 500000000 },
    step_attempts: {},
    workflow_name: 'RNA',
    workflow_version: '1.2',
  };

  it('reads what the Rust engine writes', () => {
    expect(parseResumeInfo(JSON.stringify(state))).toEqual({
      canResume: true,
      completedCount: 2,
      failedStep: 'c',
      savedAt: 1700000000500,
      workflowName: 'RNA',
      workflowVersion: '1.2',
    });
  });

  it('accepts state files from before metadata existed', () => {
    const { workflow_name, workflow_version, ...old } = state;
    const parsed = parseResumeInfo(JSON.stringify(old));
    expect(parsed.canResume).toBe(true);
    expect(parsed.workflowName).toBeNull();
  });

  it('has nothing to resume from an empty or unreadable state', () => {
    const empty = { ...state, completed_steps: [], failed_step: null };
    expect(parseResumeInfo(JSON.stringify(empty)).canResume).toBe(false);
    expect(parseResumeInfo('not json')).toEqual(NO_RESUME_INFO);
    expect(parseResumeInfo('null')).toEqual(NO_RESUME_INFO);
    expect(parseResumeInfo('[]').canResume).toBe(false);
  });
});

describe('readResumeInfo', () => {
  it('reads <workdir>/.rustrunner/<stem>.state and tolerates absence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-resume-'));
    try {
      expect(readResumeInfo(dir, 'demo')).toEqual(NO_RESUME_INFO);
      expect(readResumeInfo('', 'demo')).toEqual(NO_RESUME_INFO);

      fs.mkdirSync(path.join(dir, '.rustrunner'));
      fs.writeFileSync(
        stateFilePath(dir, 'demo'),
        JSON.stringify({ completed_steps: ['a'], failed_step: null })
      );
      const info = readResumeInfo(dir, 'demo');
      expect(info.canResume).toBe(true);
      expect(info.completedCount).toBe(1);
      expect(readResumeInfo(dir, 'other').canResume).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
