import { describe, expect, it } from 'vitest';
import {
  CHAIN_GAP,
  DEFAULT_NODE_SIZE,
  belowPosition,
  viewportToReveal,
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

describe('belowPosition', () => {
  const anchor = { x: 100, y: 50, width: 160, height: 80 };

  it('puts the next step straight under the anchor', () => {
    expect(belowPosition(anchor, [anchor])).toEqual({ x: 100, y: 50 + 80 + CHAIN_GAP });
  });

  it('moves aside when the spot under the anchor is taken', () => {
    const taken = { x: 100, y: 50 + 80 + CHAIN_GAP, width: 160, height: 80 };
    const pos = belowPosition(anchor, [anchor, taken])!;
    expect(pos.y).toBe(taken.y);
    expect(pos.x).toBeGreaterThan(taken.x + taken.width);
  });

  it('returns null when every candidate is taken', () => {
    const occupied = [anchor];
    for (let row = 0; row < 3; row++) {
      for (let col = -3; col <= 3; col++) {
        occupied.push({ x: 100 + col * 180, y: 194 + row * 144, width: 160, height: 80 });
      }
    }
    expect(belowPosition(anchor, occupied)).toBeNull();
  });
});

describe('viewportToReveal', () => {
  const size = { width: 800, height: 600 };
  const insets = { top: 10, right: 20, bottom: 30, left: 200 };

  it('leaves the viewport alone when the rect is already visible', () => {
    const vp = { x: 0, y: 0, zoom: 1 };
    expect(viewportToReveal(vp, { x: 300, y: 100, width: 160, height: 80 }, size, insets)).toEqual(vp);
  });

  it('pans up just enough to show a rect below the fold, at any zoom', () => {
    const vp = { x: 0, y: 0, zoom: 0.5 };
    const next = viewportToReveal(vp, { x: 600, y: 1200, width: 160, height: 80 }, size, insets);
    // bottom edge on screen: (1200 + 80) * 0.5 = 640 -> must be <= 570
    expect(next).toEqual({ x: 0, y: -70, zoom: 0.5 });
  });

  it('pans right to clear the left inset, and prefers the top-left when too big', () => {
    expect(viewportToReveal({ x: 0, y: 0, zoom: 1 }, { x: 50, y: 100, width: 160, height: 80 }, size, insets).x).toBe(150);
    const huge = viewportToReveal({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 1000, width: 100, height: 900 }, size, insets);
    expect(huge.y).toBe(-990);
  });
});
