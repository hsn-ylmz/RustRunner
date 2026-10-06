/**
 * Saved-run state, as the engine persists it.
 *
 * The Rust engine writes `<working dir>/.rustrunner/<workflow file stem>.state`
 * after every finished step (see RustRunner/src/workflow/state.rs) and, unless
 * told to start `--fresh`, resumes from it. The GUI reads that file to offer
 * "Resume last run". Kept free of Electron imports so it can be unit-tested.
 */

import fs from 'fs';
import path from 'path';

/** What the GUI needs to know about a saved run. */
export interface ResumeInfo {
  /** True when a state file with something to resume from exists. */
  canResume: boolean;
  /** Engine steps that finished in the earlier run(s). */
  completedCount: number;
  /** The step the last run stopped at, if it failed. */
  failedStep: string | null;
  /** When the state was last written (ms since the epoch). */
  savedAt: number | null;
  /** Workflow name/version the state was written for, when known. */
  workflowName: string | null;
  workflowVersion: string | null;
}

export const NO_RESUME_INFO: ResumeInfo = {
  canResume: false,
  completedCount: 0,
  failedStep: null,
  savedAt: null,
  workflowName: null,
  workflowVersion: null,
};

/**
 * File stem used for the workflow YAML handed to the engine, and therefore for
 * its state file. Derived from the workflow's name so two workflows run in the
 * same directory do not share (and wrongly resume from) one state file.
 */
export function workflowFileStem(name: string | undefined): string {
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/, '');
  return slug || 'workflow';
}

/** Where the engine keeps the state of `stem` when run in `workingDir`. */
export function stateFilePath(workingDir: string, stem: string): string {
  return path.join(workingDir, '.rustrunner', `${stem}.state`);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Serde writes `SystemTime` as `{ secs_since_epoch, nanos_since_epoch }`. */
function toMillis(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const secs = (value as any).secs_since_epoch;
  if (typeof secs !== 'number' || !Number.isFinite(secs)) return null;
  const nanos = (value as any).nanos_since_epoch;
  return secs * 1000 + (typeof nanos === 'number' ? Math.floor(nanos / 1e6) : 0);
}

/** Parses the contents of a state file; unusable input means "nothing to resume". */
export function parseResumeInfo(json: string): ResumeInfo {
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    return NO_RESUME_INFO;
  }
  if (typeof raw !== 'object' || raw === null) return NO_RESUME_INFO;

  const completed: unknown[] = Array.isArray(raw.completed_steps) ? raw.completed_steps : [];
  const completedCount = completed.filter((s) => typeof s === 'string').length;
  const failedStep = asString(raw.failed_step);

  return {
    canResume: completedCount > 0 || failedStep !== null,
    completedCount,
    failedStep,
    savedAt: toMillis(raw.timestamp),
    workflowName: asString(raw.workflow_name),
    workflowVersion: asString(raw.workflow_version),
  };
}

/** Reads the saved state for `stem` in `workingDir`; missing or unreadable means none. */
export function readResumeInfo(workingDir: string, stem: string): ResumeInfo {
  if (!workingDir) return NO_RESUME_INFO;
  try {
    return parseResumeInfo(fs.readFileSync(stateFilePath(workingDir, stem), 'utf-8'));
  } catch {
    return NO_RESUME_INFO;
  }
}
