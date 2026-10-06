import { describe, expect, it } from 'vitest';
import {
  BATCH_MS,
  COALESCE_MS,
  MAX_HISTORY,
  canRedo,
  canUndo,
  emptyHistory,
  record,
  redo,
  takeSnapshot,
  undo,
} from '../history';

/** Records `before` at a given time, so tests control the clock. */
const at = (now: number, key?: string) => ({ now, key });

describe('record', () => {
  it('adds an undo step and clears redo', () => {
    let h = record(emptyHistory<number>(), 1, at(0));
    expect(h.past).toEqual([1]);
    const step = undo(h, 2)!;
    expect(canRedo(step.history)).toBe(true);
    h = record(step.history, 5, at(10_000));
    expect(canRedo(h)).toBe(false);
    expect(h.past).toEqual([5]);
  });

  it('keeps at most MAX_HISTORY steps, dropping the oldest', () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < MAX_HISTORY + 10; i++) h = record(h, i, at(i * 10_000));
    expect(h.past).toHaveLength(MAX_HISTORY);
    expect(h.past[0]).toBe(10);
    expect(h.past[h.past.length - 1]).toBe(MAX_HISTORY + 9);
  });

  it('merges edits with the same key inside the window into one step', () => {
    let h = record(emptyHistory<string>(), 'a', at(0, 'n1:label'));
    h = record(h, 'ab', at(300, 'n1:label'));
    h = record(h, 'abc', at(600, 'n1:label'));
    expect(h.past).toEqual(['a']);
  });

  it('keeps the window open while the person keeps typing', () => {
    let h = record(emptyHistory<string>(), 'a', at(0, 'k'));
    for (let t = 800; t <= 4000; t += 800) h = record(h, 'x', at(t, 'k'));
    expect(h.past).toHaveLength(1);
  });

  it('starts a new step after a pause, for another key, or for a keyless edit', () => {
    let h = record(emptyHistory<string>(), 'a', at(0, 'k'));
    h = record(h, 'b', at(COALESCE_MS + 1, 'k'));
    expect(h.past).toEqual(['a', 'b']);
    h = record(h, 'c', at(COALESCE_MS + 100, 'other'));
    h = record(h, 'd', at(COALESCE_MS + 2000));
    expect(h.past).toEqual(['a', 'b', 'c', 'd']);
  });

  it('merges edits made in the same moment whatever their keys', () => {
    // Renaming a wildcard rewrites the name, the input and the output at once.
    let h = record(emptyHistory<string>(), 'before', at(100, 'n1:wildcardName'));
    h = record(h, 'half', at(100 + BATCH_MS, 'n1:input'));
    h = record(h, 'more', at(100 + BATCH_MS, 'n1:output'));
    expect(h.past).toEqual(['before']);
  });

  it('only builds the snapshot when a step is really added', () => {
    let calls = 0;
    const make = () => {
      calls += 1;
      return 'snap';
    };
    let h = record(emptyHistory<string>(), make, at(0, 'k'));
    h = record(h, make, at(100, 'k'));
    h = record(h, make, at(200, 'k'));
    expect(calls).toBe(1);
    expect(h.past).toEqual(['snap']);
  });

  it('a merged edit still drops the redo stack', () => {
    let h = record(emptyHistory<string>(), 'a', at(0, 'k'));
    h = undo(h, 'b')!.history;
    h = record(h, 'a2', at(10_000, 'k'));
    h = record(h, 'a3', at(10_100, 'k'));
    expect(canRedo(h)).toBe(false);
  });
});

describe('undo and redo', () => {
  it('do nothing on an empty history', () => {
    expect(undo(emptyHistory<number>(), 0)).toBeNull();
    expect(redo(emptyHistory<number>(), 0)).toBeNull();
    expect(canUndo(emptyHistory())).toBe(false);
  });

  it('walk back and forth through the same states', () => {
    // States 1 -> 2 -> 3, recording the state before each edit.
    let h = record(emptyHistory<number>(), 1, at(0));
    h = record(h, 2, at(10_000));
    let current = 3;

    const back1 = undo(h, current)!;
    expect(back1.state).toBe(2);
    const back2 = undo(back1.history, back1.state)!;
    expect(back2.state).toBe(1);
    expect(undo(back2.history, back2.state)).toBeNull();

    const fwd1 = redo(back2.history, back2.state)!;
    expect(fwd1.state).toBe(2);
    const fwd2 = redo(fwd1.history, fwd1.state)!;
    expect(fwd2.state).toBe(3);
    expect(redo(fwd2.history, fwd2.state)).toBeNull();
  });

  it('forget the burst key, so the next edit is its own step', () => {
    let h = record(emptyHistory<string>(), 'a', at(0, 'k'));
    const back = undo(h, 'ab')!;
    const again = record(back.history, 'a', at(50_000, 'k'));
    expect(again.past).toEqual(['a']);
  });

  it('bound the redo stack too', () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < MAX_HISTORY; i++) h = record(h, i, at(i * 10_000));
    let current = 999;
    let steps = 0;
    for (let step = undo(h, current); step; step = undo(step.history, step.state)) {
      h = step.history;
      current = step.state;
      steps += 1;
    }
    expect(steps).toBe(MAX_HISTORY);
    expect(h.future.length).toBeLessThanOrEqual(MAX_HISTORY);
  });
});

describe('takeSnapshot', () => {
  it('copies deeply and leaves out selection and drag state', () => {
    const nodes = [{ id: 'a', selected: true, dragging: true, data: { label: 'A' }, position: { x: 1, y: 2 } }];
    const edges = [{ id: 'e', selected: true, source: 'a', target: 'b' }];
    const files = { a: ['x.fq'] };
    const snap = takeSnapshot(nodes, edges, files);

    expect(snap.nodes[0]).toEqual({ id: 'a', data: { label: 'A' }, position: { x: 1, y: 2 } });
    expect(snap.edges[0]).toEqual({ id: 'e', source: 'a', target: 'b' });

    nodes[0].data.label = 'changed';
    files.a.push('y.fq');
    expect(snap.nodes[0].data.label).toBe('A');
    expect(snap.wildcardFiles.a).toEqual(['x.fq']);
  });
});
