/**
 * Run history.
 *
 * Every real run of the engine leaves `<working dir>/.rustrunner/runs/<run_id>/`
 * with `run.json` and a self-contained `report.html`, and keeps a bounded
 * `index.json` (newest first) next to them (see RustRunner/src/execution/
 * report.rs). This module reads that index for the "Run history" tab and
 * decides which report paths the app may hand to the operating system. Kept
 * free of Electron imports so it can be unit-tested.
 *
 * Everything read from disk is untrusted: the index may be hand-edited or
 * damaged, so parsing fails soft and the report location is derived from the
 * validated run id, never taken from the file.
 */

import fs from 'fs';
import path from 'path';

export type RunHistoryStatus = 'succeeded' | 'failed' | 'stopped' | 'unknown';

/** One run in the history list. */
export interface RunHistoryEntry {
  runId: string;
  /** Workflow name at the time of the run. */
  workflow: string;
  workflowId: string | null;
  status: RunHistoryStatus;
  /** RFC 3339 start time as the engine wrote it. */
  startedAt: string;
  /** Start time in ms since the epoch, null when it could not be parsed. */
  startedMs: number | null;
  durationSecs: number;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  keepGoing: boolean;
  /** Report path relative to the runs directory: `<run id>/report.html`. */
  report: string;
}

/** Directory of the runs of `workingDir`. */
export function runsDir(workingDir: string): string {
  return path.join(workingDir, '.rustrunner', 'runs');
}

/** Run ids become directory names; only plain ones are accepted. */
export function isSafeRunId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 100 && /^[A-Za-z0-9_-]+$/.test(id);
}

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

const asCount = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;

const asSeconds = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

function asStatus(v: unknown): RunHistoryStatus {
  return v === 'succeeded' || v === 'failed' || v === 'stopped' ? v : 'unknown';
}

/**
 * Parses `index.json`. Unusable input is an empty history, and an entry
 * without a usable run id is dropped. Order is kept (the engine writes newest
 * first).
 */
export function parseRunIndex(json: string): RunHistoryEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const runs = (raw as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) return [];

  const entries: RunHistoryEntry[] = [];
  for (const item of runs) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (!isSafeRunId(o.run_id)) continue;
    const startedAt = asString(o.started_at);
    const startedMs = Date.parse(startedAt);
    entries.push({
      runId: o.run_id,
      workflow: asString(o.workflow),
      workflowId: typeof o.workflow_id === 'string' && o.workflow_id !== '' ? o.workflow_id : null,
      status: asStatus(o.status),
      startedAt,
      startedMs: Number.isNaN(startedMs) ? null : startedMs,
      durationSecs: asSeconds(o.duration_secs),
      total: asCount(o.total),
      succeeded: asCount(o.succeeded),
      failed: asCount(o.failed),
      skipped: asCount(o.skipped),
      keepGoing: o.keep_going === true,
      // Derived, not read: the file's value is never used as a path.
      report: `${o.run_id}/report.html`,
    });
  }
  return entries;
}

/**
 * Whether a run belongs to the workflow: by its id when both have one, else by
 * name (runs of a workflow that had no id yet, or an old engine).
 */
export function belongsToWorkflow(
  entry: RunHistoryEntry,
  workflowName: string,
  workflowId?: string
): boolean {
  if (entry.workflowId && workflowId) return entry.workflowId === workflowId;
  return entry.workflow === workflowName;
}

/** The runs of one workflow in `workingDir`, newest first. */
export function readRunHistory(
  workingDir: string,
  workflowName: string,
  workflowId?: string
): RunHistoryEntry[] {
  if (!workingDir) return [];
  let text: string;
  try {
    text = fs.readFileSync(path.join(runsDir(workingDir), 'index.json'), 'utf-8');
  } catch {
    return [];
  }
  return parseRunIndex(text).filter((e) => belongsToWorkflow(e, workflowName, workflowId));
}

/**
 * Resolves a report reference from the renderer (relative to the runs
 * directory, or absolute as the engine reports it) to the file to open, or
 * null when it is not exactly `<run id>/report.html` inside
 * `<working dir>/.rustrunner/runs`. Symlinks are resolved first, so a link
 * cannot lead outside the directory.
 */
export function resolveReportPath(workingDir: string, reference: string): string | null {
  if (!workingDir || !path.isAbsolute(workingDir)) return null;
  if (typeof reference !== 'string' || reference === '' || reference.includes('\0')) return null;

  const base = runsDir(workingDir);
  let realBase: string;
  let realTarget: string;
  try {
    realBase = fs.realpathSync(base);
    const candidate = path.isAbsolute(reference) ? reference : path.join(base, reference);
    realTarget = fs.realpathSync(candidate);
  } catch {
    return null;
  }

  const parts = path.relative(realBase, realTarget).split(path.sep);
  if (parts.length !== 2 || parts[1] !== 'report.html' || !isSafeRunId(parts[0])) return null;
  try {
    if (!fs.statSync(realTarget).isFile()) return null;
  } catch {
    return null;
  }
  return realTarget;
}
