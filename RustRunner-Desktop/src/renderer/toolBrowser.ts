/**
 * The logic behind the tool palette, kept apart from the component so it can be
 * unit-tested: ranked search over name, description, package and file types,
 * the "fits after the selected step" filter, favourites and recently used
 * tools, and the category tree the palette shows when nothing is typed.
 */

import {
  CATALOG,
  catalogToolName,
  categoryLabel,
  inputTypesOf,
  outputTypesOf,
  typesFit,
  type Catalog,
  type CatalogTool,
} from './tools/catalog';
import { extensionsOfType } from './slots';

// -----------------------------------------------------------------------------
// Preferences: favourites and recently used
// -----------------------------------------------------------------------------

/** What the app remembers about the palette for this person. */
export interface PalettePrefs {
  favourites: string[];
  /** Newest first. */
  recent: string[];
}

export const EMPTY_PREFS: PalettePrefs = { favourites: [], recent: [] };

/** How many recently used tools the palette keeps. */
export const MAX_RECENT = 8;

/** The most favourites kept (more than the catalog will ever hold in one category). */
export const MAX_FAVOURITES = 100;

const unique = (ids: string[]) => [...new Set(ids)];

/** `ids` without anything the catalog does not know, repeats removed. */
export function knownIds(ids: unknown, catalog: Catalog = CATALOG): string[] {
  if (!Array.isArray(ids)) return [];
  const known = new Set(catalog.tools.map((t) => t.id));
  return unique(ids.filter((id): id is string => typeof id === 'string' && known.has(id)));
}

/** Preferences read from disk (untrusted), reduced to tools that exist and to the limits. */
export function cleanPrefs(raw: unknown, catalog: Catalog = CATALOG): PalettePrefs {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    favourites: knownIds(r.favourites, catalog).slice(0, MAX_FAVOURITES),
    recent: knownIds(r.recent, catalog).slice(0, MAX_RECENT),
  };
}

/** Adds the tool to the favourites, or removes it when it is already one. */
export function toggleFavourite(prefs: PalettePrefs, id: string): PalettePrefs {
  const has = prefs.favourites.includes(id);
  const favourites = has
    ? prefs.favourites.filter((f) => f !== id)
    : [...prefs.favourites, id].slice(-MAX_FAVOURITES);
  return { ...prefs, favourites };
}

/** Puts the tool first in the recently used list (no repeats, at most `MAX_RECENT`). */
export function recordRecent(prefs: PalettePrefs, id: string): PalettePrefs {
  return { ...prefs, recent: [id, ...prefs.recent.filter((r) => r !== id)].slice(0, MAX_RECENT) };
}

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

/** What a tool is searched by, lower case. */
interface Haystack {
  name: string;
  id: string;
  pkg: string;
  category: string;
  subcategory: string;
  description: string;
  /** Type names and their file extensions: "bam", "fq", ".fastq". */
  types: string[];
}

function haystackOf(tool: CatalogTool, catalog: Catalog): Haystack {
  const types = [...new Set([...inputTypesOf(tool), ...outputTypesOf(tool)])];
  const withExtensions = types.flatMap((t) => [t, ...extensionsOfType(t)]);
  return {
    name: tool.name.toLowerCase(),
    id: tool.id.toLowerCase(),
    pkg: catalogToolName(tool).toLowerCase(),
    category: `${tool.category} ${categoryLabel(tool.category, catalog)}`.toLowerCase(),
    subcategory: tool.subcategory.toLowerCase(),
    description: tool.description.toLowerCase(),
    types: withExtensions,
  };
}

const wordsOf = (text: string) => text.split(/[^a-z0-9]+/).filter(Boolean);

/** The edit distance between two short words, or more than 1 once it is clear it exceeds 1. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * How well one search word matches a tool: 0 for no match. A name that starts
 * with the word beats a word inside the name, which beats the package, the
 * category and the description; a file type matches exactly or by extension;
 * a misspelt word of four or more letters still finds a name within one edit.
 */
function scoreWord(word: string, h: Haystack): number {
  let best = 0;
  const bump = (n: number) => {
    if (n > best) best = n;
  };
  const nameWords = wordsOf(h.name);

  if (h.name === word || h.id === word) bump(100);
  else if (h.name.startsWith(word) || h.id.startsWith(word)) bump(80);
  else if (nameWords.some((w) => w.startsWith(word))) bump(65);
  else if (h.name.includes(word) || h.id.includes(word)) bump(50);

  if (h.pkg === word) bump(60);
  else if (h.pkg.includes(word)) bump(40);

  if (h.types.includes(word) || h.types.includes(word.replace(/^\./, ''))) bump(35);

  if (h.subcategory.includes(word)) bump(30);
  if (h.category.includes(word)) bump(25);
  if (wordsOf(h.description).some((w) => w.startsWith(word))) bump(20);
  else if (h.description.includes(word)) bump(10);

  if (best === 0 && word.length >= 4) {
    if (nameWords.some((w) => w.length >= 4 && withinOneEdit(word, w))) bump(15);
  }
  return best;
}

/**
 * The tools matching `query`, best match first (catalog order breaks ties).
 * Every word of the query has to match something; an empty query keeps the
 * catalog order. `pool` narrows what is searched (a category, "fits after").
 */
export function rankTools(
  query: string,
  pool: CatalogTool[] = CATALOG.tools,
  catalog: Catalog = CATALOG
): CatalogTool[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...pool];
  const scored: Array<{ tool: CatalogTool; score: number; at: number }> = [];
  pool.forEach((tool, at) => {
    const h = haystackOf(tool, catalog);
    let total = 0;
    for (const word of words) {
      const s = scoreWord(word, h);
      if (s === 0) return;
      total += s;
    }
    scored.push({ tool, score: total, at });
  });
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((s) => s.tool);
}

// -----------------------------------------------------------------------------
// Fits after the selected step
// -----------------------------------------------------------------------------

/**
 * Whether `tool` can read something `previous` writes: one of the previous
 * tool's output types is an input type of this tool (`any` fits everything).
 */
export function fitsAfter(tool: CatalogTool, previous: CatalogTool): boolean {
  return typesFit(outputTypesOf(previous), inputTypesOf(tool));
}

/** The tools that fit after `previous`, in catalog order. */
export function toolsFittingAfter(previous: CatalogTool, pool: CatalogTool[] = CATALOG.tools): CatalogTool[] {
  return pool.filter((t) => fitsAfter(t, previous));
}

/** The output types of `previous` this tool can read, for "reads the BAM it makes". */
export function sharedTypes(tool: CatalogTool, previous: CatalogTool): string[] {
  const reads = inputTypesOf(tool);
  return outputTypesOf(previous).filter((t) => reads.includes(t) || reads.includes('any'));
}

// -----------------------------------------------------------------------------
// The category tree
// -----------------------------------------------------------------------------

export interface SubcategoryGroup {
  name: string;
  tools: CatalogTool[];
}

export interface CategoryGroup {
  id: string;
  label: string;
  color: string;
  count: number;
  subcategories: SubcategoryGroup[];
}

/** Tools grouped by category, then subcategory, in the catalog's category order. */
export function groupTools(tools: CatalogTool[], catalog: Catalog = CATALOG): CategoryGroup[] {
  const groups: CategoryGroup[] = [];
  for (const id of Object.keys(catalog.categories)) {
    const inCategory = tools.filter((t) => t.category === id);
    if (inCategory.length === 0) continue;
    const subs: SubcategoryGroup[] = [];
    for (const tool of inCategory) {
      let sub = subs.find((s) => s.name === tool.subcategory);
      if (!sub) subs.push((sub = { name: tool.subcategory, tools: [] }));
      sub.tools.push(tool);
    }
    groups.push({
      id,
      label: catalog.categories[id].label,
      color: catalog.categories[id].color,
      count: inCategory.length,
      subcategories: subs,
    });
  }
  return groups;
}

/** One line of the palette's keyboard order: a category heading or a tool. */
export type NavItem =
  | { kind: 'category'; key: string; id: string }
  | { kind: 'tool'; key: string; tool: CatalogTool };

/**
 * The rows the arrow keys move over when browsing: favourites, recently used,
 * then each category heading followed by its tools when it is open.
 */
export function browseOrder(
  groups: CategoryGroup[],
  favourites: CatalogTool[],
  recent: CatalogTool[],
  open: ReadonlySet<string>
): NavItem[] {
  const items: NavItem[] = [];
  for (const tool of favourites) items.push({ kind: 'tool', key: `fav-${tool.id}`, tool });
  for (const tool of recent) items.push({ kind: 'tool', key: `recent-${tool.id}`, tool });
  for (const group of groups) {
    items.push({ kind: 'category', key: `cat-${group.id}`, id: group.id });
    if (!open.has(group.id)) continue;
    for (const sub of group.subcategories) {
      for (const tool of sub.tools) items.push({ kind: 'tool', key: `tool-${tool.id}`, tool });
    }
  }
  return items;
}

/** The index after moving `by` rows from `from`, staying inside 0..length-1 (no wrapping). */
export function moveIndex(from: number, by: number, length: number): number {
  if (length <= 0) return -1;
  return Math.min(length - 1, Math.max(0, from + by));
}
