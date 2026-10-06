/**
 * Small pure helpers for naming a step, reading its thread count and its file
 * lists. They sit in their own module so the tool catalog and the slot logic
 * can use them without importing the workflow conversion (which imports both).
 */

/** The engine step id for a node label: lowercase words joined by underscores. */
export function labelToId(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/** Coerces a threads value from the UI into a positive integer. */
export function normalizeThreads(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** The wildcard name a node uses until the user picks another one. */
export const DEFAULT_WILDCARD_NAME = 'sample';

/** Longest wildcard name the Properties panel accepts. */
export const MAX_WILDCARD_NAME_LENGTH = 40;

/**
 * Names the engine reads as command placeholders (`{input}`, `{output}`, ...);
 * a wildcard called that would rewrite the command, so the engine rejects it.
 */
const RESERVED_WILDCARD_NAMES = ['input', 'output', 'inputs', 'outputs', 'threads'];

/** Why `value` cannot name a wildcard, or null when it can (blank = default). */
export function wildcardNameError(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '') return null;
  if (name.length > MAX_WILDCARD_NAME_LENGTH) {
    return `Use at most ${MAX_WILDCARD_NAME_LENGTH} characters`;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return 'Start with a letter or underscore, then use only letters, digits and underscores';
  }
  if (RESERVED_WILDCARD_NAMES.includes(name.toLowerCase())) {
    return `"${name}" is a command placeholder; pick another name`;
  }
  return null;
}

/** The wildcard name a node uses: its own when valid, else the default. */
export function normalizeWildcardName(value: unknown): string {
  if (typeof value !== 'string' || wildcardNameError(value) !== null) {
    return DEFAULT_WILDCARD_NAME;
  }
  return value.trim() || DEFAULT_WILDCARD_NAME;
}

/** The `{name}` wildcards used in a path pattern, in order, without repeats. */
export function extractWildcardNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** The individual outputs of an output field (comma-separated, like the engine reads it). */
export function declaredOutputs(output: unknown): string[] {
  if (typeof output !== 'string') return [];
  return output
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

