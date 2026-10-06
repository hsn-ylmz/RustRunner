/**
 * Step run state
 *
 * Folds the engine's typed run events (`--json-events`, parsed in the main
 * process by src/main/engineEvents.ts and forwarded on 'workflow-event') into
 * per-step state, so the canvas badges and the status panel can show live
 * progress. The raw log is a separate stream and is never parsed here.
 *
 * The engine only reports steps it knows about, so an event for a step id that
 * does not belong to any canvas node is ignored by the callers rather than
 * guessed at (see `resolveBaseStepId`).
 */

import type { EngineEvent } from '../main/engineEvents';

export type StepState =
  | 'pending'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export type StepEvent =
  | { kind: 'start'; stepId: string; attempt?: number; maxAttempts?: number }
  | { kind: 'attempt'; stepId: string; attempt: number; maxAttempts: number }
  | {
      kind: 'retry';
      stepId: string;
      /** The attempt that failed. */
      attempt: number;
      maxAttempts: number;
      /** Seconds the engine waits before the next attempt. */
      delaySecs?: number;
    }
  | { kind: 'done'; stepId: string }
  | { kind: 'skipped'; stepId: string; reason?: string }
  | { kind: 'failed'; stepId: string; message: string }
  | { kind: 'check'; stepId: string; blocking: boolean; message: string };

/**
 * Translates an engine event into a step event, or null for the events that do
 * not concern a single step (`run_started`, `run_finished`).
 *
 * The first attempt of a step is a 'start' (it resets whatever an earlier run
 * left), later attempts are 'attempt's.
 */
export function toStepEvent(event: EngineEvent): StepEvent | null {
  switch (event.event) {
    case 'step_started':
      return event.attempt <= 1
        ? {
            kind: 'start',
            stepId: event.step,
            attempt: event.attempt,
            maxAttempts: event.max_attempts,
          }
        : {
            kind: 'attempt',
            stepId: event.step,
            attempt: event.attempt,
            maxAttempts: event.max_attempts,
          };
    case 'step_retrying':
      return {
        kind: 'retry',
        stepId: event.step,
        attempt: event.attempt,
        maxAttempts: event.max_attempts,
        delaySecs: event.delay_secs,
      };
    case 'step_succeeded':
      return { kind: 'done', stepId: event.step };
    case 'step_failed':
      return { kind: 'failed', stepId: event.step, message: event.reason };
    case 'step_skipped':
      return { kind: 'skipped', stepId: event.step, reason: event.reason };
    case 'check_failed':
      return {
        kind: 'check',
        stepId: event.step,
        blocking: event.blocking,
        message: event.message,
      };
    default:
      return null;
  }
}

/**
 * Maps an engine step id back to the canvas node it came from.
 *
 * Wildcard expansion renames a step to `<baseId>_<wildcardValue>`, so one node
 * can produce many engine steps. Exact matches win; otherwise the longest
 * base id that prefixes the engine id (followed by `_`) is used, which keeps
 * `align` from swallowing steps belonging to `align_sorted`.
 *
 * Returns null when nothing matches — an id we can't attribute is ignored
 * rather than guessed at.
 */
export function resolveBaseStepId(
  engineStepId: string,
  baseIds: readonly string[]
): string | null {
  if (baseIds.includes(engineStepId)) return engineStepId;

  let best: string | null = null;
  for (const base of baseIds) {
    if (
      engineStepId.startsWith(`${base}_`) &&
      (best === null || base.length > best.length)
    ) {
      best = base;
    }
  }

  return best;
}

/** What is known about one engine step (a wildcard node expands into many). */
export interface StepRun {
  state: StepState;
  /** Latest attempt number, when the engine reported one. */
  attempt?: number;
  maxAttempts?: number;
  /** Seconds until the next attempt, while 'retrying'. */
  delaySecs?: number;
  /** Why the step failed or was skipped. */
  message?: string;
  /** Non-blocking output checks that failed. */
  warnings?: string[];
}

/** Engine step id -> what is known about it, in the order first seen. */
export type StepRuns = Record<string, StepRun>;

/** Folds one engine event into the per-engine-step map. */
export function applyRunEvent(runs: StepRuns, event: StepEvent): StepRuns {
  const prev: StepRun | undefined = runs[event.stepId];
  let next: StepRun;

  switch (event.kind) {
    case 'start':
      next = {
        state: 'running',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
      };
      break;
    case 'attempt':
      next = {
        ...prev,
        state: 'running',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delaySecs: undefined,
      };
      break;
    case 'retry':
      next = {
        ...prev,
        state: 'retrying',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delaySecs: event.delaySecs,
      };
      break;
    case 'done':
      next = { ...prev, state: 'succeeded', message: undefined, delaySecs: undefined };
      break;
    case 'skipped':
      next = { state: 'skipped', message: event.reason };
      break;
    case 'failed':
      next = { ...prev, state: 'failed', message: event.message, delaySecs: undefined };
      break;
    case 'check':
      // A blocking failure is followed by the step's own failure; only the
      // advisory ones are kept, as warnings on a step that goes on.
      if (event.blocking) return runs;
      next = {
        state: 'running',
        ...prev,
        warnings: [...(prev?.warnings ?? []), event.message],
      };
      break;
  }

  return { ...runs, [event.stepId]: next };
}

/** Per-node rollup of the engine steps it expanded into. */
export interface NodeStatus {
  state: StepState;
  /** Engine steps finished (succeeded, failed or skipped) for this node. */
  finished: number;
  /** Engine steps seen for this node so far. */
  total: number;
  /** First failure message, when state is 'failed'. */
  message?: string;
  /** The failed attempt of the first retrying instance, when 'retrying'. */
  attempt?: number;
  maxAttempts?: number;
}

const FINISHED: ReadonlySet<StepState> = new Set(['succeeded', 'failed', 'skipped']);

/**
 * Rolls engine steps up to the canvas nodes they came from.
 *
 * A node is `failed` if any instance failed, `retrying` if any is between
 * attempts, `running` if any is still running, and otherwise `skipped` when
 * every instance was skipped or `succeeded`. Counts are of instances
 * *observed* — the engine doesn't announce the expansion size up front, so
 * they grow as the run proceeds. Nodes with no observed instance are absent.
 */
export function rollupNodeStatuses(
  runs: StepRuns,
  baseIds: readonly string[]
): Record<string, NodeStatus> {
  const grouped = new Map<string, StepRun[]>();
  for (const [engineId, run] of Object.entries(runs)) {
    const baseId = resolveBaseStepId(engineId, baseIds);
    if (!baseId) continue;
    grouped.set(baseId, [...(grouped.get(baseId) ?? []), run]);
  }

  const out: Record<string, NodeStatus> = {};
  for (const [baseId, instances] of grouped) {
    const finished = instances.filter((r) => FINISHED.has(r.state)).length;
    const failed = instances.find((r) => r.state === 'failed');
    const retrying = instances.find((r) => r.state === 'retrying');
    let state: StepState;
    if (failed) state = 'failed';
    else if (instances.some((r) => r.state === 'retrying')) state = 'retrying';
    else if (instances.some((r) => r.state === 'running')) state = 'running';
    else if (instances.every((r) => r.state === 'skipped')) state = 'skipped';
    else state = 'succeeded';

    out[baseId] = {
      state,
      finished,
      total: instances.length,
      message: failed?.message,
      attempt: state === 'retrying' ? retrying?.attempt : undefined,
      maxAttempts: state === 'retrying' ? retrying?.maxAttempts : undefined,
    };
  }
  return out;
}

/** A line of the step status panel. */
export interface StatusRow {
  /** Engine step id (or the node's step id for a node that never ran). */
  id: string;
  /** Canvas node label the step belongs to. */
  label: string;
  state: StepState;
  attempt?: number;
  maxAttempts?: number;
  delaySecs?: number;
  message?: string;
  warnings?: string[];
}

/** Where a run is: before any run, running, or finished. */
export type RunPhase = 'none' | 'active' | 'ended';

/**
 * Builds the rows of the status panel: one per engine step seen so far, plus
 * one per canvas node that has not produced any. Those are `pending` while the
 * run is active and `skipped` once it has ended (a failure or stop upstream,
 * or a resume that had nothing left to do for them). Rows follow canvas order.
 */
export function buildStatusRows(
  runs: StepRuns,
  nodes: ReadonlyArray<{ stepId: string; label: string }>,
  phase: RunPhase
): StatusRow[] {
  if (phase === 'none') return [];
  const baseIds = nodes.map((n) => n.stepId);
  const rows: StatusRow[] = [];

  for (const node of nodes) {
    const own = Object.entries(runs).filter(
      ([engineId]) => resolveBaseStepId(engineId, baseIds) === node.stepId
    );
    if (own.length === 0) {
      rows.push({
        id: node.stepId,
        label: node.label,
        state: phase === 'active' ? 'pending' : 'skipped',
      });
      continue;
    }
    for (const [engineId, run] of own) {
      rows.push({ id: engineId, label: node.label, ...run });
    }
  }
  return rows;
}

/** Row counts per state, for the panel's summary line. */
export function summarizeRows(rows: readonly StatusRow[]): Record<StepState, number> {
  const counts: Record<StepState, number> = {
    pending: 0,
    running: 0,
    retrying: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}
