import { describe, it, expect } from 'vitest';
import { formatCounts, formatDuration, formatStarted } from '../runHistoryFormat';
import type { RunHistoryEntry } from '../../main/runHistory';

const run = (over: Partial<RunHistoryEntry> = {}): RunHistoryEntry => ({
  runId: 'r1',
  workflow: 'Demo',
  workflowId: null,
  status: 'succeeded',
  startedAt: '2026-01-01T00:00:00.000Z',
  startedMs: Date.parse('2026-01-01T00:00:00.000Z'),
  durationSecs: 1,
  total: 5,
  succeeded: 3,
  failed: 1,
  skipped: 1,
  keepGoing: false,
  report: 'r1/report.html',
  ...over,
});

describe('formatDuration', () => {
  it('picks a readable unit', () => {
    expect(formatDuration(0.25)).toBe('250 ms');
    expect(formatDuration(12.34)).toBe('12.3 s');
    expect(formatDuration(247)).toBe('4 min 07 s');
    expect(formatDuration(3720)).toBe('1 h 02 min');
  });
  it('is empty for nonsense', () => {
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});

describe('formatCounts', () => {
  it('lists only the non-zero parts', () => {
    expect(formatCounts(run())).toBe('3 succeeded, 1 failed, 1 skipped of 5');
    expect(formatCounts(run({ failed: 0, skipped: 0, succeeded: 5 }))).toBe('5 succeeded of 5');
  });
});

describe('formatStarted', () => {
  it('shows the raw text when the time is not a date', () => {
    expect(formatStarted({ startedAt: 'garbage', startedMs: null })).toBe('garbage');
    expect(formatStarted(run())).not.toBe('');
  });
});
