/**
 * Undo / redo history for the canvas. Pure functions over an immutable value,
 * so the rules (bounded depth, coalescing a burst of edits into one step,
 * redo cleared by a new edit) are unit-tested without React.
 *
 * The caller passes the state as it was *before* an edit to `record`, and the
 * state as it is *now* to `undo` / `redo`, which hands back the state to show.
 */

/** Cap on undo depth: enough for a working session, bounded in memory. */
export const MAX_HISTORY = 50;

/** Edits to the same field closer together than this are one undo step. */
export const COALESCE_MS = 1000;

/**
 * Edits recorded this close together came from one action (renaming a wildcard
 * rewrites three fields), so they are one undo step whatever their keys.
 */
export const BATCH_MS = 5;

export interface History<T> {
  /** Oldest first; the last entry is what undo restores. */
  past: T[];
  /** Most recently undone last; what redo restores. */
  future: T[];
  /** What the last recorded edit was, for coalescing. */
  lastKey?: string;
  lastAt?: number;
}

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

export const canUndo = (h: History<unknown>): boolean => h.past.length > 0;
export const canRedo = (h: History<unknown>): boolean => h.future.length > 0;

export interface RecordOptions {
  /**
   * Identifies the edit (for example `node_1:label`). A later edit with the
   * same key inside the window extends the earlier step instead of adding one,
   * so typing a name is one undo, not one per keystroke.
   */
  key?: string;
  /** Milliseconds clock, injectable for tests. */
  now?: number;
  /** Overrides COALESCE_MS for this edit. */
  windowMs?: number;
}

/**
 * Notes that an edit is about to change the state. `before` is the state as it
 * is now, or a function making it, which is only called when a step is really
 * added (copying the canvas on every keystroke of a burst would be wasted).
 * A new edit also drops the redo stack: redo only makes sense straight after
 * an undo.
 */
export function record<T>(
  h: History<T>,
  before: T | (() => T),
  options: RecordOptions = {}
): History<T> {
  const { key, now = Date.now(), windowMs = COALESCE_MS } = options;
  const elapsed = h.lastAt === undefined ? Infinity : now - h.lastAt;
  const sameBurst = key !== undefined && h.lastKey === key && elapsed <= windowMs;
  const sameAction = elapsed <= BATCH_MS;

  if (h.past.length > 0 && (sameBurst || sameAction)) {
    // The step already holds the state from before the burst began.
    return { ...h, future: [], lastAt: now };
  }
  const state = typeof before === 'function' ? (before as () => T)() : before;
  return {
    past: [...h.past, state].slice(-MAX_HISTORY),
    future: [],
    lastKey: key,
    lastAt: now,
  };
}

export interface Step<T> {
  history: History<T>;
  /** The state to show. */
  state: T;
}

/** Steps back. `current` is saved so redo can return to it. Null when there is nothing to undo. */
export function undo<T>(h: History<T>, current: T): Step<T> | null {
  if (h.past.length === 0) return null;
  const state = h.past[h.past.length - 1];
  return {
    state,
    history: {
      past: h.past.slice(0, -1),
      future: [...h.future, current].slice(-MAX_HISTORY),
    },
  };
}

/** Steps forward again after an undo. Null when there is nothing to redo. */
export function redo<T>(h: History<T>, current: T): Step<T> | null {
  if (h.future.length === 0) return null;
  const state = h.future[h.future.length - 1];
  return {
    state,
    history: {
      past: [...h.past, current].slice(-MAX_HISTORY),
      future: h.future.slice(0, -1),
    },
  };
}

/** The part of the editor state that undo covers. */
export interface GraphSnapshot {
  nodes: any[];
  edges: any[];
  wildcardFiles: Record<string, string[]>;
}

/**
 * A deep copy without transient UI state (selection, drag), so undoing a
 * delete does not bring the node back half-selected.
 */
export function takeSnapshot(
  nodes: any[],
  edges: any[],
  wildcardFiles: Record<string, string[]>
): GraphSnapshot {
  const clean = (item: any) => {
    const { selected: _s, dragging: _d, ...rest } = item;
    return JSON.parse(JSON.stringify(rest));
  };
  return {
    nodes: nodes.map(clean),
    edges: edges.map(clean),
    wildcardFiles: JSON.parse(JSON.stringify(wildcardFiles)),
  };
}
