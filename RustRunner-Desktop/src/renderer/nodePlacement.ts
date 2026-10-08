/**
 * Pure geometry for placing a new node on the canvas without covering an
 * existing one. Everything here is in flow coordinates (React Flow's own
 * space), so zoom and pan do not matter.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Size assumed for a node that has not been measured yet, in flow units. */
export const DEFAULT_NODE_SIZE = { width: 160, height: 80 };

/** Minimum empty space kept between two nodes, in flow units. */
const GAP = 16;

/** True when the two rectangles overlap, treating `GAP` as part of each. */
export function rectsOverlap(a: Rect, b: Rect, gap: number = GAP): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

/**
 * Rectangles of the nodes already on the canvas. Uses the measured size when
 * React Flow has one, the default otherwise.
 */
export function occupiedRects(nodes: any[]): Rect[] {
  return nodes.map((n: any) => ({
    x: n.position?.x ?? 0,
    y: n.position?.y ?? 0,
    width: n.measured?.width ?? n.width ?? DEFAULT_NODE_SIZE.width,
    height: n.measured?.height ?? n.height ?? DEFAULT_NODE_SIZE.height,
  }));
}

/** The largest existing node's size, a good guess for how big a new one is. */
export function typicalNodeSize(occupied: Rect[]): { width: number; height: number } {
  return occupied.reduce(
    (size, r) => ({
      width: Math.max(size.width, r.width),
      height: Math.max(size.height, r.height),
    }),
    { ...DEFAULT_NODE_SIZE }
  );
}

/**
 * Returns the first of `candidates` whose node-sized rectangle is clear of
 * every occupied rectangle, or null when all of them collide.
 */
export function firstFreePosition(
  candidates: Iterable<{ x: number; y: number }>,
  occupied: Rect[]
): { x: number; y: number } | null {
  const size = typicalNodeSize(occupied);
  for (const c of candidates) {
    const rect = { x: c.x, y: c.y, ...size };
    if (!occupied.some((o) => rectsOverlap(rect, o))) return c;
  }
  return null;
}
