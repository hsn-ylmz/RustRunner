/**
 * Engine run events.
 *
 * Started with `--json-events`, the Rust CLI writes one JSON object per line to
 * stderr, each line prefixed with `RUSTRUNNER_EVENT ` (see
 * RustRunner/src/execution/events.rs for the schema and ordering guarantees).
 * This module picks those lines out of the engine's output, validates them and
 * leaves everything else as ordinary log text. Kept free of Electron imports so
 * it can be unit-tested; the renderer imports its types only.
 *
 * Parsing fails soft: a line that is not a well-formed version-1 event is never
 * an exception. Malformed event lines stay in the log (so nothing is hidden),
 * while well-formed events of an unknown name or a newer schema version are
 * dropped (an engine newer than the app may add events).
 */

/** Marks an event line. Must match EVENT_PREFIX in the engine. */
export const EVENT_PREFIX = 'RUSTRUNNER_EVENT ';

/** The schema version this app understands. */
export const SCHEMA_VERSION = 1;

export type RunStatus = 'succeeded' | 'failed' | 'stopped';

export interface RunSummary {
  total: number;
  succeeded: number;
  failed: number;
  /** Not run: finished in an earlier run, or never reached. */
  skipped: number;
  /** Steps that needed more than one attempt. */
  retried: number;
  check_warnings: number;
  duration_secs: number;
  /** Why the run did not succeed. */
  error?: string;
}

export type EngineEventBody =
  | { event: 'run_started'; workflow: string; run_id: string; steps: string[]; dry_run: boolean }
  | { event: 'step_started'; step: string; attempt: number; max_attempts: number }
  | {
      event: 'step_retrying';
      step: string;
      /** The attempt that failed. */
      attempt: number;
      max_attempts: number;
      delay_secs: number;
      reason: string;
    }
  | { event: 'step_succeeded'; step: string; attempts: number }
  | { event: 'step_failed'; step: string; reason: string; attempts: number }
  | { event: 'step_skipped'; step: string; reason: string }
  | {
      event: 'check_failed';
      step: string;
      kind: 'exists' | 'non_empty' | 'min_lines' | string;
      blocking: boolean;
      message: string;
    }
  | { event: 'run_finished'; status: RunStatus; summary: RunSummary };

/** One event as it arrives over IPC. */
export type EngineEvent = { v: 1; ts: string } & EngineEventBody;

/** What one line of engine output turned out to be. */
export type ParsedLine =
  | { type: 'event'; event: EngineEvent }
  /** A well-formed event this app does not know; dropped. */
  | { type: 'ignored' }
  /** Anything else: ordinary log text. */
  | { type: 'text' };

type Obj = Record<string, unknown>;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;

function validSummary(s: unknown): s is RunSummary {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Obj;
  return (
    isInt(o.total) &&
    isInt(o.succeeded) &&
    isInt(o.failed) &&
    isInt(o.skipped) &&
    isInt(o.retried) &&
    isInt(o.check_warnings) &&
    isNum(o.duration_secs) &&
    (o.error === undefined || isStr(o.error))
  );
}

/** Per-event field checks. An event name missing here is unknown. */
const VALIDATORS: Record<string, (o: Obj) => boolean> = {
  run_started: (o) =>
    isStr(o.workflow) &&
    isStr(o.run_id) &&
    Array.isArray(o.steps) &&
    o.steps.every(isStr) &&
    isBool(o.dry_run),
  step_started: (o) => isStr(o.step) && isInt(o.attempt) && isInt(o.max_attempts),
  step_retrying: (o) =>
    isStr(o.step) &&
    isInt(o.attempt) &&
    isInt(o.max_attempts) &&
    isInt(o.delay_secs) &&
    isStr(o.reason),
  step_succeeded: (o) => isStr(o.step) && isInt(o.attempts),
  step_failed: (o) => isStr(o.step) && isStr(o.reason) && isInt(o.attempts),
  step_skipped: (o) => isStr(o.step) && isStr(o.reason),
  check_failed: (o) =>
    isStr(o.step) && isStr(o.kind) && isBool(o.blocking) && isStr(o.message),
  run_finished: (o) =>
    (o.status === 'succeeded' || o.status === 'failed' || o.status === 'stopped') &&
    validSummary(o.summary),
};

/** Classifies one line (without its newline) of engine output. */
export function parseEngineLine(line: string): ParsedLine {
  if (!line.startsWith(EVENT_PREFIX)) return { type: 'text' };

  let value: unknown;
  try {
    value = JSON.parse(line.slice(EVENT_PREFIX.length));
  } catch {
    return { type: 'text' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { type: 'text' };
  }

  const obj = value as Obj;
  if (!isInt(obj.v) || !isStr(obj.event)) return { type: 'text' };
  if (obj.v !== SCHEMA_VERSION) return { type: 'ignored' };

  const validate = Object.prototype.hasOwnProperty.call(VALIDATORS, obj.event)
    ? VALIDATORS[obj.event]
    : undefined;
  if (!validate) return { type: 'ignored' };
  // A known event with the wrong shape is a bug somewhere: keep it visible.
  if (!validate(obj)) return { type: 'text' };

  return { type: 'event', event: obj as unknown as EngineEvent };
}

/** The result of feeding output to an {@link EngineOutputSplitter}. */
export interface SplitOutput {
  events: EngineEvent[];
  /** Log text with the event lines removed, newlines kept. */
  text: string;
}

/**
 * Splits a stream of output chunks into events and log text.
 *
 * Chunks end anywhere, so an incomplete last line is held back until its
 * newline arrives (or {@link flush} is called when the stream ends).
 */
export class EngineOutputSplitter {
  private pending = '';

  push(chunk: string): SplitOutput {
    const data = this.pending + chunk;
    const lastNewline = data.lastIndexOf('\n');
    if (lastNewline === -1) {
      this.pending = data;
      return { events: [], text: '' };
    }
    this.pending = data.slice(lastNewline + 1);
    return this.classify(data.slice(0, lastNewline + 1));
  }

  /** Releases a held-back incomplete line, for when the stream has ended. */
  flush(): SplitOutput {
    const rest = this.pending;
    this.pending = '';
    return this.classify(rest);
  }

  private classify(complete: string): SplitOutput {
    const events: EngineEvent[] = [];
    let text = '';
    // Keep each line's own terminator so log text round-trips exactly.
    for (const raw of complete.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const line = raw.replace(/\r?\n$/, '');
      const parsed = parseEngineLine(line);
      if (parsed.type === 'event') events.push(parsed.event);
      else if (parsed.type === 'text') text += raw;
    }
    return { events, text };
  }
}
