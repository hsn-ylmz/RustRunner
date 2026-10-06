import { describe, expect, it } from 'vitest';
import {
  classifyLogLine,
  classifyLogLines,
  describeLogCount,
  extractStderrTail,
  filterLogLines,
  logsToText,
} from '../logLines';

const LOG = [
  'Starting step: make',
  '[WARN] disk is nearly full',
  "[ERROR] Step 'make' failed with exit code: Some(1)",
  '[ERROR] stderr:',
  'cp: no such file',
  'aborting',
  'Workflow failed: make',
  'plain text',
];

describe('classifyLogLine', () => {
  it('prefers the engine prefixes over keywords', () => {
    expect(classifyLogLine('[WARN] this failed to matter')).toBe('warning');
    expect(classifyLogLine('[ERROR] x')).toBe('error');
    expect(classifyLogLine('Step failed')).toBe('error');
    expect(classifyLogLine('Workflow completed successfully!')).toBe('success');
    expect(classifyLogLine('hello')).toBe('');
  });
});

describe('classifyLogLines', () => {
  it('gives the stderr text under the header the error severity', () => {
    expect(classifyLogLines(LOG)).toEqual([
      'info',
      'warning',
      'error',
      'error',
      'error',
      'error',
      'error',
      '',
    ]);
  });

  it('ends the stderr block at the next classified line', () => {
    const out = classifyLogLines(['[ERROR] stderr:', 'oops', 'Starting step: b', 'after']);
    expect(out).toEqual(['error', 'error', 'info', '']);
  });
});

describe('filterLogLines', () => {
  it('shows everything by default, keeping log indexes', () => {
    const rows = filterLogLines(LOG, 'all', '');
    expect(rows).toHaveLength(LOG.length);
    expect(rows[3].index).toBe(3);
  });

  it('filters by severity', () => {
    expect(filterLogLines(LOG, 'errors', '').map((r) => r.line)).toEqual([
      "[ERROR] Step 'make' failed with exit code: Some(1)",
      '[ERROR] stderr:',
      'cp: no such file',
      'aborting',
      'Workflow failed: make',
    ]);
    expect(filterLogLines(LOG, 'warnings', '').map((r) => r.line)).toEqual(['[WARN] disk is nearly full']);
  });

  it('searches case-insensitively and combines with the filter', () => {
    expect(filterLogLines(LOG, 'all', 'ABORT').map((r) => r.line)).toEqual(['aborting']);
    expect(filterLogLines(LOG, 'errors', 'plain')).toEqual([]);
    expect(filterLogLines(LOG, 'all', '   ')).toHaveLength(LOG.length);
  });

  it('copies what is shown', () => {
    expect(logsToText(filterLogLines(LOG, 'warnings', ''))).toBe('[WARN] disk is nearly full');
    expect(logsToText([])).toBe('');
  });
});

describe('describeLogCount', () => {
  it('says how much is shown', () => {
    expect(describeLogCount(1, 1)).toBe('1 line');
    expect(describeLogCount(8, 8)).toBe('8 lines');
    expect(describeLogCount(3, 340)).toBe('3 of 340 lines');
    expect(describeLogCount(0, 1)).toBe('0 of 1 line');
  });
});

describe('extractStderrTail', () => {
  it('returns the stderr of the named step', () => {
    expect(extractStderrTail(LOG, 'make')).toEqual(['cp: no such file', 'aborting']);
  });

  it('takes the last failure of a retried step and the end of long output', () => {
    const lines = [
      "[ERROR] Step 's' failed with exit code: Some(1)",
      '[ERROR] stderr:',
      'old',
      "[ERROR] Step 's' failed with exit code: Some(1)",
      '[ERROR] stderr:',
      'a',
      'b',
      'c',
    ];
    expect(extractStderrTail(lines, 's')).toEqual(['a', 'b', 'c']);
    expect(extractStderrTail(lines, 's', 2)).toEqual(['b', 'c']);
  });

  it('is empty for another step, no stderr, or a missing block', () => {
    expect(extractStderrTail(LOG, 'other')).toEqual([]);
    expect(
      extractStderrTail(["[ERROR] Step 's' failed with exit code: Some(1)", 'Starting step: t'], 's')
    ).toEqual([]);
    expect(extractStderrTail(["[ERROR] Step 's' failed with exit code: Some(1)"], 's')).toEqual([]);
  });

  it('does not mistake a step whose name has regex characters', () => {
    expect(extractStderrTail(["[ERROR] Step 'a.b' failed with exit code: Some(1)", '[ERROR] stderr:', 'x'], 'a.b')).toEqual(['x']);
    expect(extractStderrTail(["[ERROR] Step 'axb' failed with exit code: Some(1)", '[ERROR] stderr:', 'x'], 'a.b')).toEqual([]);
  });

  it('stops at the app timestamped lines', () => {
    const lines = [
      "[ERROR] Step 's' timed out and exceeded its 5s timeout",
    ];
    expect(extractStderrTail(lines, 's')).toEqual([]);
  });
});
