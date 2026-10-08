/**
 * What the template gallery shows: searching and filtering the cards, the
 * words on a card, and the geometry of the small pipeline drawing. Pure.
 */

import { CATALOG, findTool, type Catalog } from '../tools/catalog';
import { normalizeNodeColor } from '../nodeColors';
import {
  DIFFICULTIES,
  READ_LAYOUTS,
  TEMPLATE_DOMAINS,
  TEMPLATE_NODE_SIZE,
  databaseNeeds,
  toolsUsed,
  type WorkflowTemplate,
} from './schema';

export type TemplateSource = 'bundled' | 'user';

export interface GalleryEntry {
  template: WorkflowTemplate;
  source: TemplateSource;
  /** What was changed to fit this app's tool list (a user template from an older version); shown in the setup step. */
  notes?: string[];
}

/** A user template file that could not be used, with what is wrong. */
export interface BrokenTemplate {
  id: string;
  problems: string[];
}

/** The domain's words, or the id itself for one this version does not know. */
export function domainLabel(domain: string): string {
  return TEMPLATE_DOMAINS[domain] ?? domain;
}

/** The domains of `entries`, in the gallery's usual order, for the filter. */
export function domainsOf(entries: GalleryEntry[]): string[] {
  const present = new Set(entries.map((e) => e.template.domain));
  const known = Object.keys(TEMPLATE_DOMAINS).filter((d) => present.has(d));
  return [...known, ...[...present].filter((d) => !(d in TEMPLATE_DOMAINS)).sort()];
}

/** The words a search looks in: name, description, topic, level and tools. */
function haystack(template: WorkflowTemplate, catalog: Catalog): string {
  return [
    template.name,
    template.description,
    template.details,
    domainLabel(template.domain),
    DIFFICULTIES[template.difficulty] ?? '',
    template.readLayout ? READ_LAYOUTS[template.readLayout] : '',
    ...toolsUsed(template, catalog),
  ]
    .join(' ')
    .toLowerCase();
}

/** The entries that contain every word of `query` and belong to `domain` ('' is every domain). */
export function filterEntries(
  entries: GalleryEntry[],
  query: string,
  domain: string,
  catalog: Catalog = CATALOG
): GalleryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (domain && entry.template.domain !== domain) return false;
    const text = haystack(entry.template, catalog);
    return words.every((w) => text.includes(w));
  });
}

/** "Paired-end reads" for a short-read template that says how it wants its reads; null otherwise. */
/** The paragraphs of a template's "what this does" text: a blank line starts a new one. */
export function detailParagraphs(details: string): string[] {
  return details
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function readLayoutLabel(template: Pick<WorkflowTemplate, 'readLayout'>): string | null {
  return template.readLayout ? READ_LAYOUTS[template.readLayout] ?? null : null;
}

/** "4 steps", "1 step". */
export function stepCountLabel(template: Pick<WorkflowTemplate, 'steps'>): string {
  const n = template.steps.length;
  return n === 1 ? '1 step' : `${n} steps`;
}

/** The tools of a template as one line: "FastQC, fastp, MultiQC". */
export function toolsLine(template: Pick<WorkflowTemplate, 'steps'>, catalog: Catalog = CATALOG): string {
  return toolsUsed(template, catalog).join(', ');
}

export interface DagNode {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** A node colour name (`--node-<name>`), from the tool's category. */
  color: string;
  label: string;
}

export interface DagEdge {
  from: string;
  to: string;
  /** An SVG path from the bottom of the earlier step to the top of the later one. */
  path: string;
}

export interface Dag {
  width: number;
  height: number;
  nodes: DagNode[];
  edges: DagEdge[];
}

/**
 * The drawing of a template: each step as a box where it sits on the canvas,
 * each connection as a curve from the bottom of one box to the top of the next.
 * Coordinates start at 0 with `padding` around, so the viewBox is `0 0 width height`.
 */
export function dagOf(
  template: Pick<WorkflowTemplate, 'steps' | 'edges'>,
  catalog: Catalog = CATALOG,
  padding = 16
): Dag {
  const { width, height } = TEMPLATE_NODE_SIZE;
  const minX = Math.min(...template.steps.map((s) => s.position.x));
  const minY = Math.min(...template.steps.map((s) => s.position.y));
  const nodes: DagNode[] = template.steps.map((s) => {
    const tool = findTool(s.tool, catalog);
    return {
      key: s.key,
      x: s.position.x - minX + padding,
      y: s.position.y - minY + padding,
      width,
      height,
      color: normalizeNodeColor(tool ? catalog.categories[tool.category]?.color : undefined),
      label: s.label?.trim() || tool?.name || s.key,
    };
  });
  const at = (key: string) => nodes.find((n) => n.key === key);
  const edges: DagEdge[] = [];
  for (const e of template.edges) {
    const a = at(e.from);
    const b = at(e.to);
    if (!a || !b) continue;
    const x1 = a.x + a.width / 2;
    const y1 = a.y + a.height;
    const x2 = b.x + b.width / 2;
    const y2 = b.y;
    const bend = Math.max(24, (y2 - y1) / 2);
    edges.push({ from: e.from, to: e.to, path: `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}` });
  }
  return {
    width: Math.max(...nodes.map((n) => n.x + n.width)) + padding,
    height: Math.max(...nodes.map((n) => n.y + n.height)) + padding,
    nodes,
    edges,
  };
}

/** A sentence for a screen reader: "Pipeline of 4 steps: FastQC (raw reads), then ...". */
export function dagDescription(template: Pick<WorkflowTemplate, 'steps' | 'edges'>, catalog: Catalog = CATALOG): string {
  const dag = dagOf(template, catalog);
  const ordered = [...dag.nodes].sort((a, b) => a.y - b.y || a.x - b.x).map((n) => n.label);
  return `Pipeline of ${stepCountLabel(template)}: ${ordered.join(', then ')}.`;
}

/** True when the template has a tool that needs a database set up first. */
export function needsDatabase(template: Pick<WorkflowTemplate, 'steps'>, catalog: Catalog = CATALOG): boolean {
  return databaseNeeds(template, catalog).length > 0;
}
