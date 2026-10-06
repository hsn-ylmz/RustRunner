import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NODE_SIZE,
  firstFreePosition,
  occupiedRects,
  rectsOverlap,
} from '../nodePlacement';

const rect = (x: number, y: number, width = 100, height = 50) => ({ x, y, width, height });

describe('rectsOverlap', () => {
  it('detects overlapping and separate rectangles', () => {
    expect(rectsOverlap(rect(0, 0), rect(50, 20), 0)).toBe(true);
    expect(rectsOverlap(rect(0, 0), rect(200, 0), 0)).toBe(false);
  });

  it('treats the gap as occupied space', () => {
    expect(rectsOverlap(rect(0, 0), rect(105, 0), 10)).toBe(true);
    expect(rectsOverlap(rect(0, 0), rect(105, 0), 0)).toBe(false);
  });
});

describe('occupiedRects', () => {
  it('prefers measured size and falls back to the default', () => {
    const rects = occupiedRects([
      { position: { x: 1, y: 2 }, measured: { width: 300, height: 90 } },
      { position: { x: 5, y: 6 } },
    ]);
    expect(rects[0]).toEqual({ x: 1, y: 2, width: 300, height: 90 });
    expect(rects[1]).toEqual({ x: 5, y: 6, ...DEFAULT_NODE_SIZE });
  });
});

describe('firstFreePosition', () => {
  it('skips candidates that land on an existing node', () => {
    const occupied = [rect(0, 0, 160, 80)];
    const free = firstFreePosition(
      [
        { x: 10, y: 10 },
        { x: 100, y: 40 },
        { x: 400, y: 400 },
      ],
      occupied
    );
    expect(free).toEqual({ x: 400, y: 400 });
  });

  it('returns the first candidate when the canvas is empty', () => {
    expect(firstFreePosition([{ x: 3, y: 4 }], [])).toEqual({ x: 3, y: 4 });
  });

  it('returns null when every candidate collides', () => {
    expect(firstFreePosition([{ x: 0, y: 0 }], [rect(0, 0)])).toBeNull();
  });
});
