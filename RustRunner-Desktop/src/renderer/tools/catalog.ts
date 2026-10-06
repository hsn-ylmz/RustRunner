/**
 * The bundled tool catalog: types, search, command rendering and file-type
 * matching. Pure logic, no React or Electron imports, so it is unit-testable.
 *
 * `catalog.json` is data only. A catalog entry becomes an ordinary node whose
 * `tool` is the conda package, so the engine and the saved YAML do not know
 * the catalog exists; the node keeps `catalogId` and `catalogParams` only so
 * the Properties panel can show the parameter form and re-render the command.
 */

import catalogJson from './catalog.json';
import { labelToId, normalizeThreads } from '../workflowConversion';

export type ParamType = 'number' | 'string' | 'boolean' | 'select';

export type ParamValue = string | number | boolean;

export interface ToolParam {
  id: string;
  label: string;
  type: ParamType;
  default: ParamValue;
  description: string;
  /** Allowed values of a `select` parameter. */
  options?: string[];
  /** Bounds of a `number` parameter. */
  min?: number;
  max?: number;
  /** What a ticked `boolean` parameter adds to the command; unticked adds nothing. */
  flag?: string;
  /** A `string` parameter that must be filled in before the tool can run. */
  required?: boolean;
}

export interface CatalogTool {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Bioconda package. The node's tool is set to it; the engine builds the environment from it. */
  conda: { package: string };
  /**
   * Command template. `{input}`, `{output}` stay in the command for the engine
   * to fill; `{threads}` and `{<param id>}` are filled by the editor.
   */
  command: string;
  defaultThreads: number;
  inputTypes: string[];
  outputTypes: string[];
  defaultInput: string;
  defaultOutput: string;
  params: ToolParam[];
}

export interface Catalog {
  schemaVersion: number;
  version: string;
  fileTypes: string[];
  categories: Record<string, { label: string; color: string }>;
  tools: CatalogTool[];
}

export const CATALOG: Catalog = catalogJson as unknown as Catalog;

/** The parameter types the form can render. */
export const PARAM_TYPES: ParamType[] = ['number', 'string', 'boolean', 'select'];

/** Placeholders the engine fills in at run time; the editor leaves them alone. */
export const ENGINE_PLACEHOLDERS = ['input', 'output'];

/** Matches `{name}` placeholders, with the one space before it (see `renderCommand`). */
const PLACEHOLDER = / ?\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The placeholder names a template uses, in order, without repeats. */
export function templatePlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

export function findTool(id: unknown, catalog: Catalog = CATALOG): CatalogTool | undefined {
  return typeof id === 'string' ? catalog.tools.find((t) => t.id === id) : undefined;
}

export function categoryLabel(category: string, catalog: Catalog = CATALOG): string {
  return catalog.categories[category]?.label ?? category;
}

/**
 * Tools matching `query`, in catalog order. Every word of the query must occur
 * in the tool's name, id, category, conda package or description (case
 * insensitive). `category` narrows the result to one category.
 */
export function searchTools(
  query: string,
  category: string = '',
  catalog: Catalog = CATALOG
): CatalogTool[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.tools.filter((tool) => {
    if (category && tool.category !== category) return false;
    const haystack = [
      tool.name,
      tool.id,
      tool.category,
      categoryLabel(tool.category, catalog),
      tool.conda.package,
      tool.description,
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The parameter values a new node starts with. */
export function defaultParams(tool: CatalogTool): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const param of tool.params) values[param.id] = param.default;
  return values;
}

/** Quotes a value for bash unless it only holds characters that are safe unquoted. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The number a `number` parameter stands for: its default when `raw` is unusable, clamped to its bounds. */
export function coerceNumber(param: ToolParam, raw: unknown): number {
  let n = typeof raw === 'number' ? raw : raw === '' || raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n)) n = Number(param.default);
  if (param.min !== undefined) n = Math.max(n, param.min);
  if (param.max !== undefined) n = Math.min(n, param.max);
  return n;
}

/**
 * The text a parameter adds to the command, or null when it is a required
 * string that is still empty (the placeholder then stays in the command so the
 * gap is visible).
 */
function renderParam(param: ToolParam, raw: unknown): string | null {
  switch (param.type) {
    case 'number':
      return String(coerceNumber(param, raw));
    case 'boolean': {
      const on = raw === true || raw === 'true';
      return on ? param.flag ?? '' : '';
    }
    case 'select': {
      const value = typeof raw === 'string' ? raw : String(raw ?? '');
      return param.options?.includes(value) ? value : String(param.default);
    }
    case 'string': {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value === '') return param.required ? null : '';
      return shellQuote(value);
    }
  }
}

/**
 * Fills a catalog command template. `{threads}` and the tool's parameters are
 * replaced; `{input}`, `{output}` and any unknown placeholder stay as they are.
 * A parameter that renders empty (an unticked flag, an empty optional string)
 * also removes the space before it, so no double spaces are left behind.
 */
export function renderCommand(
  tool: CatalogTool,
  params: Record<string, unknown> = {},
  threads: unknown = tool.defaultThreads
): string {
  return tool.command.replace(PLACEHOLDER, (match: string, name: string) => {
    if (ENGINE_PLACEHOLDERS.includes(name)) return match;
    const lead = match.startsWith(' ') ? ' ' : '';
    if (name === 'threads') return lead + String(normalizeThreads(threads));
    const param = tool.params.find((p) => p.id === name);
    if (!param) return match;
    const text = renderParam(param, name in params ? params[name] : param.default);
    if (text === null) return match;
    return text === '' ? '' : lead + text;
  });
}

/** Ids of required parameters that are still empty. */
export function missingRequiredParams(
  tool: CatalogTool,
  params: Record<string, unknown> = {}
): string[] {
  return tool.params
    .filter((p) => p.required && p.type === 'string')
    .filter((p) => {
      const value = p.id in params ? params[p.id] : p.default;
      return typeof value !== 'string' || value.trim() === '';
    })
    .map((p) => p.id);
}

/**
 * A label for a new node that no other node uses. Two labels clash when they
 * give the same step id, so "FastQC" and "fastqc 2" count as different but
 * "FastQC" and "fastqc" do not.
 */
export function uniqueLabel(base: string, existingLabels: string[]): string {
  const taken = new Set(existingLabels.map((l) => labelToId(l)));
  if (!taken.has(labelToId(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(labelToId(candidate))) return candidate;
  }
}

/** The data of a node freshly made from a catalog tool. */
export function buildCatalogNodeData(
  tool: CatalogTool,
  existingLabels: string[],
  catalog: Catalog = CATALOG
): Record<string, unknown> {
  const params = defaultParams(tool);
  return {
    label: uniqueLabel(tool.name, existingLabels),
    tool: tool.conda.package,
    command: renderCommand(tool, params, tool.defaultThreads),
    input: tool.defaultInput,
    output: tool.defaultOutput,
    threads: tool.defaultThreads,
    color: catalog.categories[tool.category]?.color,
    catalogId: tool.id,
    catalogParams: params,
  };
}

/**
 * A node's data after a parameter or the thread count changed. The command is
 * rendered again unless the user has edited it by hand (`catalogCommandCustom`),
 * so typing in the command box is never overwritten behind their back.
 */
export function applyParamChange(
  tool: CatalogTool,
  data: Record<string, any>,
  change: { params?: Record<string, ParamValue>; threads?: unknown }
): Record<string, unknown> {
  const params = change.params ?? data.catalogParams ?? defaultParams(tool);
  const threads = 'threads' in change ? change.threads : data.threads;
  const patch: Record<string, unknown> = {};
  if (change.params) patch.catalogParams = params;
  if (data.catalogCommandCustom !== true) patch.command = renderCommand(tool, params, threads);
  return patch;
}

/** Run-time check: catalog steps whose generated command still has a gap. */
export function validateCatalogNodes(nodes: any[], catalog: Catalog = CATALOG): string[] {
  const errors: string[] = [];
  for (const node of nodes) {
    const data = node.data ?? {};
    const tool = findTool(data.catalogId, catalog);
    if (!tool || data.catalogCommandCustom === true) continue;
    const missing = missingRequiredParams(tool, data.catalogParams);
    if (missing.length > 0) {
      const names = missing
        .map((id) => tool.params.find((p) => p.id === id)?.label ?? id)
        .join(', ');
      errors.push(`Step ${labelToId(data.label || '')}: fill in ${names}`);
    }
  }
  return errors;
}

export type TypeCheckStatus = 'match' | 'mismatch' | 'unknown';

export interface TypeCheck {
  status: TypeCheckStatus;
  /** The file types both ends agree on (only for `match`). */
  shared: string[];
  /** One sentence for the edge tooltip. */
  message: string;
  /** For `mismatch`: what the source makes and what the target expects. */
  made?: string[];
  expected?: string[];
}

/**
 * Galaxy-style check of a connection: does something `source` produces fit
 * something `target` accepts? Never blocks; it only informs. When either end is
 * not a catalog tool its types are unknown and the edge stays neutral.
 */
export function checkConnection(
  source: CatalogTool | undefined,
  target: CatalogTool | undefined
): TypeCheck {
  if (!source || !target) {
    return {
      status: 'unknown',
      shared: [],
      message: 'File types are not checked: one of the steps is not a catalog tool.',
    };
  }
  const shared = source.outputTypes.filter((t) => target.inputTypes.includes(t));
  if (shared.length > 0) {
    return {
      status: 'match',
      shared,
      message: `Types match: ${source.name} makes ${shared.join(', ')}, which ${target.name} accepts.`,
    };
  }
  return {
    status: 'mismatch',
    shared: [],
    made: source.outputTypes,
    expected: target.inputTypes,
    message:
      `Types differ: ${source.name} makes ${source.outputTypes.join(', ')}, ` +
      `but ${target.name} expects ${target.inputTypes.join(', ')}. The connection still works.`,
  };
}

/** The check of one edge, looked up from the nodes it joins. */
export function checkEdge(edge: any, nodes: any[], catalog: Catalog = CATALOG): TypeCheck {
  const source = nodes.find((n: any) => n.id === edge.source);
  const target = nodes.find((n: any) => n.id === edge.target);
  return checkConnection(
    findTool(source?.data?.catalogId, catalog),
    findTool(target?.data?.catalogId, catalog)
  );
}
