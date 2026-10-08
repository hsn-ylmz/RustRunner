/**
 * The colours a node can have.
 *
 * A node stores the colour's NAME ("sky"), and the stylesheet turns the name
 * into `var(--node-sky)`, so a theme change reaches every node. Workflow files
 * saved before the design system hold the old hex value instead; LEGACY_HEX
 * maps those to the nearest named colour so they still open and look right.
 * The legacy mapping is the only place in the renderer, apart from the token
 * file, that may contain colour literals.
 */

export interface NodeColor {
  /** What is stored in the workflow file and what follows `--node-` in the tokens. */
  id: string;
  /** Shown to people (swatch name, tooltip). */
  label: string;
}

export const NODE_COLORS: readonly NodeColor[] = [
  { id: 'mint', label: 'Mint' },
  { id: 'sky', label: 'Sky' },
  { id: 'lilac', label: 'Lilac' },
  { id: 'sand', label: 'Sand' },
  { id: 'rose', label: 'Rose' },
  { id: 'peach', label: 'Peach' },
  { id: 'lemon', label: 'Lemon' },
  { id: 'sage', label: 'Sage' },
  { id: 'periwinkle', label: 'Periwinkle' },
  { id: 'lavender', label: 'Lavender' },
];

export const DEFAULT_NODE_COLOR = 'sky';

/** Hex values written by earlier versions, and the colour each one became. */
const LEGACY_HEX: Record<string, string> = {
  '#a8e6cf': 'mint',
  '#88c5f7': 'sky',
  '#d4a5f7': 'lilac',
  '#f5efe9': 'sand',
  '#ef4444': 'rose',
  '#f97316': 'peach',
  '#eab308': 'lemon',
  '#22c55e': 'sage',
  '#3b82f6': 'periwinkle',
  '#8b5cf6': 'lavender',
};

const IDS = new Set(NODE_COLORS.map((c) => c.id));

/** True when `value` is one of the colour names. */
export function isNodeColorId(value: unknown): value is string {
  return typeof value === 'string' && IDS.has(value);
}

/**
 * The colour name for whatever a node holds: a name, an old hex value, or
 * nothing or something unknown (which gets the default).
 */
export function normalizeNodeColor(value: unknown): string {
  if (isNodeColorId(value)) return value;
  if (typeof value === 'string') {
    const legacy = LEGACY_HEX[value.trim().toLowerCase()];
    if (legacy) return legacy;
  }
  return DEFAULT_NODE_COLOR;
}

/** The CSS value that paints a node of this colour. */
export function nodeColorVar(value: unknown): string {
  return `var(--node-${normalizeNodeColor(value)})`;
}

/** The label of a node's colour, for a swatch's accessible name. */
export function nodeColorLabel(value: unknown): string {
  const id = normalizeNodeColor(value);
  return NODE_COLORS.find((c) => c.id === id)?.label ?? id;
}

/** Names of the legacy hex values (for tests). */
export const LEGACY_NODE_COLOR_HEX = Object.keys(LEGACY_HEX);
