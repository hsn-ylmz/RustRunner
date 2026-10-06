import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  belongsToWorkflow,
  isSafeRunId,
  parseRunIndex,
  readRunHistory,
  resolveReportPath,
  runsDir,
} from './runHistory';

const entry = (over: Record<string, unknown> = {}) => ({
  run_id: '20260101T000000Z-1',
  workflow: 'Demo',
  workflow_id: 'demo-id',
  status: 'succeeded',
  started_at: '2026-01-01T00:00:00.000Z',
  finished_at: '2026-01-01T00:00:03.500Z',
  duration_secs: 3.5,
  total: 4,
  succeeded: 3,
  failed: 0,
  skipped: 1,
  keep_going: true,
  report: '20260101T000000Z-1/report.html',
  ...over,
});

const index = (...runs: unknown[]) => JSON.stringify({ version: 1, runs });

describe('parseRunIndex', () => {
  it('reads the engine index, newest first as written', () => {
    const runs = parseRunIndex(
      index(entry(), entry({ run_id: 'older', status: 'failed', failed: 2, started_at: '2025-12-31T10:00:00Z' }))
    );
    expect(runs.map((r) => r.runId)).toEqual(['20260101T000000Z-1', 'older']);
    expect(runs[0]).toEqual({
      runId: '20260101T000000Z-1',
      workflow: 'Demo',
      workflowId: 'demo-id',
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      startedMs: Date.parse('2026-01-01T00:00:00.000Z'),
      durationSecs: 3.5,
      total: 4,
      succeeded: 3,
      failed: 0,
      skipped: 1,
      keepGoing: true,
      report: '20260101T000000Z-1/report.html',
    });
    expect(runs[1].status).toBe('failed');
  });

  it('treats unusable input as an empty history', () => {
    expect(parseRunIndex('')).toEqual([]);
    expect(parseRunIndex('{ nope')).toEqual([]);
    expect(parseRunIndex('[]')).toEqual([]);
    expect(parseRunIndex('null')).toEqual([]);
    expect(parseRunIndex(JSON.stringify({ runs: 'x' }))).toEqual([]);
  });

  it('drops entries without a safe run id', () => {
    const runs = parseRunIndex(
      index(
        entry({ run_id: '../../etc' }),
        entry({ run_id: 'a/b' }),
        entry({ run_id: '' }),
        entry({ run_id: 7 }),
        null,
        'x',
        entry({ run_id: 'good_1-2' })
      )
    );
    expect(runs.map((r) => r.runId)).toEqual(['good_1-2']);
  });

  it('never uses the index file for the report path', () => {
    const [run] = parseRunIndex(index(entry({ report: '../../../etc/passwd' })));
    expect(run.report).toBe('20260101T000000Z-1/report.html');
  });

  it('survives missing and mistyped fields', () => {
    const [run] = parseRunIndex(
      index({ run_id: 'r1', status: 'exploded', total: -3, duration_secs: 'x', started_at: 'not a date' })
    );
    expect(run).toMatchObject({
      status: 'unknown',
      total: 0,
      durationSecs: 0,
      startedMs: null,
      workflow: '',
      workflowId: null,
      keepGoing: false,
    });
  });
});

describe('belongsToWorkflow', () => {
  const [run] = parseRunIndex(index(entry()));
  it('matches by id when both sides have one', () => {
    expect(belongsToWorkflow(run, 'Renamed', 'demo-id')).toBe(true);
    expect(belongsToWorkflow(run, 'Demo', 'other-id')).toBe(false);
  });
  it('falls back to the name', () => {
    expect(belongsToWorkflow(run, 'Demo')).toBe(true);
    expect(belongsToWorkflow(run, 'Other')).toBe(false);
    const [noId] = parseRunIndex(index(entry({ workflow_id: undefined })));
    expect(belongsToWorkflow(noId, 'Demo', 'new-id')).toBe(true);
  });
});

describe('files', () => {
  let work: string;
  beforeEach(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-history-')));
  });
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  const makeRun = (id: string) => {
    const dir = path.join(runsDir(work), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.html'), '<html></html>');
    return path.join(dir, 'report.html');
  };

  it('reads only the runs of the workflow', () => {
    fs.mkdirSync(runsDir(work), { recursive: true });
    fs.writeFileSync(
      path.join(runsDir(work), 'index.json'),
      index(entry({ run_id: 'mine' }), entry({ run_id: 'theirs', workflow: 'Other', workflow_id: 'x' }))
    );
    expect(readRunHistory(work, 'Demo', 'demo-id').map((r) => r.runId)).toEqual(['mine']);
    expect(readRunHistory(work, 'Nothing', 'nope')).toEqual([]);
  });

  it('is empty without an index or a working directory', () => {
    expect(readRunHistory(work, 'Demo')).toEqual([]);
    expect(readRunHistory('', 'Demo')).toEqual([]);
  });

  describe('resolveReportPath', () => {
    it('accepts a run id path and the absolute path from the engine', () => {
      const report = makeRun('r1');
      expect(resolveReportPath(work, 'r1/report.html')).toBe(report);
      expect(resolveReportPath(work, report)).toBe(report);
    });

    it('rejects everything that is not <run id>/report.html inside the run folder', () => {
      makeRun('r1');
      fs.writeFileSync(path.join(work, 'secret.html'), 'x');
      fs.writeFileSync(path.join(runsDir(work), 'r1', 'run.json'), '{}');
      for (const bad of [
        '',
        '..',
        '../secret.html',
        'r1/../../../secret.html',
        path.join(work, 'secret.html'),
        '/etc/passwd',
        'r1/run.json',
        'r1',
        'r1/report.html/../run.json',
        'missing/report.html',
        'r1/report.html\0.png',
      ]) {
        expect(resolveReportPath(work, bad), JSON.stringify(bad)).toBeNull();
      }
    });

    it('rejects a missing or relative working directory', () => {
      makeRun('r1');
      expect(resolveReportPath('', 'r1/report.html')).toBeNull();
      expect(resolveReportPath('relative/dir', 'r1/report.html')).toBeNull();
      expect(resolveReportPath(path.join(work, 'nope'), 'r1/report.html')).toBeNull();
    });

    it('does not follow a symlink out of the run folder', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-outside-'));
      try {
        fs.writeFileSync(path.join(outside, 'report.html'), 'x');
        fs.mkdirSync(runsDir(work), { recursive: true });
        fs.symlinkSync(outside, path.join(runsDir(work), 'link'));
        expect(resolveReportPath(work, 'link/report.html')).toBeNull();
        // A report that is itself a link to a file elsewhere.
        const dir = path.join(runsDir(work), 'r2');
        fs.mkdirSync(dir);
        fs.symlinkSync(path.join(outside, 'report.html'), path.join(dir, 'report.html'));
        expect(resolveReportPath(work, 'r2/report.html')).toBeNull();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('rejects a directory named report.html', () => {
      fs.mkdirSync(path.join(runsDir(work), 'r3', 'report.html'), { recursive: true });
      expect(resolveReportPath(work, 'r3/report.html')).toBeNull();
    });
  });
});

describe('isSafeRunId', () => {
  it('accepts engine run ids and refuses path-like ones', () => {
    expect(isSafeRunId('20260101T000000Z-4242')).toBe(true);
    expect(isSafeRunId('a b')).toBe(false);
    expect(isSafeRunId('..')).toBe(false);
    expect(isSafeRunId('a'.repeat(101))).toBe(false);
  });
});
