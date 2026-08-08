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
 *   Step '<id>' completed successfully         engine.rs  (info)
 *   [ERROR] Step '<id>' failed: <message>      engine.rs  (error)
 *   [DRY RUN] Step: <id>                       engine.rs  (stdout)
 *
 * This is inherently coupled to engine wording, so parsing MUST fail soft:
 * an unrecognized line simply returns null and flows to the log pane as before.
 * The durable fix is a machine-readable `--json-events` stream from the engine;
 * when that lands, only this file changes.
 */

export type StepState = 'pending' | 'running' | 'done' | 'failed';

export type StepEvent =
  | { kind: 'start'; stepId: string }
  | { kind: 'done'; stepId: string }
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

/** Per-node rollup of the engine steps it expanded into. */
export interface NodeStatus {
  state: StepState;
  /** Engine steps finished (done or failed) for this node. */
  finished: number;
  /** Engine steps seen for this node so far. */
  total: number;
  /** First failure message, when state is 'failed'. */
  message?: string;
}

/**
 * Folds step events into per-base-id status.
 *
 * A node is `failed` if any of its instances failed, `running` if any is still
 * running, and `done` only once every instance it produced has finished. Counts
 * are of instances *observed* — the engine doesn't announce the expansion size
 * up front, so this grows as the run proceeds.
 */
export function applyStepEvent(
  statuses: Record<string, NodeStatus>,
  event: StepEvent,
  baseIds: readonly string[]
): Record<string, NodeStatus> {
  const baseId = resolveBaseStepId(event.stepId, baseIds);
  if (!baseId) return statuses;

  const prev: NodeStatus = statuses[baseId] ?? {
    state: 'pending',
    finished: 0,
    total: 0,
  };

  let next: NodeStatus;

  switch (event.kind) {
    case 'start':
      next = {
        ...prev,
        total: prev.total + 1,
        // A failure already recorded for a sibling instance stays sticky.
        state: prev.state === 'failed' ? 'failed' : 'running',
      };
      break;

    case 'done': {
      const finished = prev.finished + 1;
      // 'done' can arrive for a step whose 'start' we never saw (dry run
      // prints only the one line), so keep total at least as large.
      const total = Math.max(prev.total, finished);
      next = {
        ...prev,
        finished,
        total,
        state:
          prev.state === 'failed'
            ? 'failed'
            : finished >= total
              ? 'done'
              : 'running',
      };
      break;
    }

    case 'failed': {
      const finished = prev.finished + 1;
      next = {
        state: 'failed',
        finished,
        total: Math.max(prev.total, finished),
        message: prev.message ?? event.message,
      };
      break;
    }
  }

  return { ...statuses, [baseId]: next };
}
