/**
 * Step Event Parsing
 *
 * Derives per-step execution state from the engine's log output so the canvas
 * can show live progress.
 *
 * The Rust engine has no structured event stream; it writes human-readable
 * lines via `env_logger`, configured in RustRunner/src/main.rs to emit the bare
 * message for info/debug and `[LEVEL] message` for warn/error. Both stdout and
 * stderr are forwarded to the renderer on the 'workflow-output' channel, so the
 * lines below are all we have to work with:
 *
 *   Starting step: <id>                        engine.rs  (info)
 *   Step '<id>': attempt <n>/<max>             step.rs    (info)
 *   [WARN] Step '<id>': attempt <n>/<max> failed (...); will retry
 *   Skipping previously completed step: <id>   planner.rs (info, resumed runs)
 *   Step '<id>' completed successfully         engine.rs  (info)
 *   [ERROR] Step '<id>' failed: <message>      engine.rs  (error)
 *   [DRY RUN] Step: <id>                       engine.rs  (stdout)
 *
 * This is inherently coupled to engine wording, so parsing MUST fail soft:
 * an unrecognized line simply returns null and flows to the log pane as before.
 * The durable fix is a machine-readable `--json-events` stream from the engine;
 * when that lands, only this file changes.
 */

export type StepState =
  | 'pending'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export type StepEvent =
  | { kind: 'start'; stepId: string }
  | { kind: 'attempt'; stepId: string; attempt: number; maxAttempts: number }
  | { kind: 'retry'; stepId: string; attempt: number; maxAttempts: number }
  | { kind: 'done'; stepId: string }
  | { kind: 'skipped'; stepId: string }
  | { kind: 'failed'; stepId: string; message: string };

const PATTERNS: Array<{
  re: RegExp;
  build: (m: RegExpMatchArray) => StepEvent;
}> = [
  {
    re: /^Starting step:\s*(.+?)\s*$/,
    build: (m) => ({ kind: 'start', stepId: m[1] }),
  },
  {
    // Printed by the engine for every attempt of a step that has retries.
    re: /^Step '(.+?)': attempt (\d+)\/(\d+)\s*$/,
    build: (m) => ({
      kind: 'attempt',
      stepId: m[1],
      attempt: Number(m[2]),
      maxAttempts: Number(m[3]),
    }),
  },
  {
    // A failed attempt that will be retried (step.rs, warn level).
    re: /^\[WARN\]\s*Step '(.+?)': attempt (\d+)\/(\d+) failed\b.*will retry\s*$/,
    build: (m) => ({
      kind: 'retry',
      stepId: m[1],
      attempt: Number(m[2]),
      maxAttempts: Number(m[3]),
    }),
  },
  {
    // A step a resumed run does not repeat (planner.rs, info level).
    re: /^Skipping previously completed step:\s*(.+?)\s*$/,
    build: (m) => ({ kind: 'skipped', stepId: m[1] }),
  },
  {
    re: /^\[DRY RUN\] Step:\s*(.+?)\s*$/,
    build: (m) => ({ kind: 'done', stepId: m[1] }),
  },
  {
    re: /^Step '(.+?)' completed successfully\s*$/,
    build: (m) => ({ kind: 'done', stepId: m[1] }),
  },
  {
    re: /^\[ERROR\]\s*Step '(.+?)' failed:\s*(.*)$/,
    build: (m) => ({ kind: 'failed', stepId: m[1], message: m[2] }),
  },
];

/**
 * Parses a single log line into a step event, or null if it isn't one.
 * Timestamps/level prefixes beyond the engine's own format are not expected,
 * but leading whitespace is tolerated.
 */
export function parseStepEvent(line: string): StepEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  for (const { re, build } of PATTERNS) {
    const match = trimmed.match(re);
    if (match) return build(match);
  }

  return null;
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
  /** Failure message, when state is 'failed'. */
  message?: string;
}

/** Engine step id -> what is known about it, in the order first seen. */
export type StepRuns = Record<string, StepRun>;

/** Folds one engine event into the per-engine-step map. */
export function applyRunEvent(runs: StepRuns, event: StepEvent): StepRuns {
  const prev: StepRun | undefined = runs[event.stepId];
  let next: StepRun;

  switch (event.kind) {
    case 'start':
      next = { state: 'running' };
      break;
    case 'attempt':
      next = {
        ...prev,
        state: 'running',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
      };
      break;
    case 'retry':
      next = {
        ...prev,
        state: 'retrying',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
      };
      break;
    case 'done':
      next = { ...prev, state: 'succeeded', message: undefined };
      break;
    case 'skipped':
      next = { state: 'skipped' };
      break;
    case 'failed':
      next = { ...prev, state: 'failed', message: event.message };
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
  message?: string;
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
