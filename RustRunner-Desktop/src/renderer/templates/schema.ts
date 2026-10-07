/**
 * Workflow templates: the file format and its validation.
 *
 * A template is a versioned JSON document that describes a ready-made
 * pipeline in the words of a biologist: what it does, which files the person
 * must bring (the template's inputs), and the steps with their options. Steps
 * are always catalog tools, so a template never holds a command: the app
 * builds the command from the tool, exactly as when a tool is added by hand.
 *
 *   formatVersion     1
 *   id                lowercase letters, digits and dashes; also the file name of a user template
 *   name, description a title and one sentence for the gallery card
 *   details           the longer "what this does" text of the setup step
 *   domain, difficulty  for filtering and for setting expectations
 *   minCatalogVersion the oldest tool catalog the template works with
 *   inputs            the files the person provides; each names the step slots it fills
 *   steps             catalog tool + options + default file names + a position on the canvas
 *   edges             which step runs after which, and which output fills which slot
 *   outputs           what the finished run produces, shown before the workflow is created
 *   references        citations and links
 *
 * Whether a tool needs a database is not stored: it comes from the catalog
 * (`needs_database`), so it cannot go out of date.
 *
 * Everything here is pure (no React, no Electron) so it is unit-tested. The
 * same `validateTemplate` checks the bundled templates in the test suite and
 * the user's own template files when they are loaded.
 */

import {
  CATALOG,
  findTool,
  missingRequiredParams,
  typesFit,
  type Catalog,
  type CatalogTool,
  type ParamValue,
} from '../tools/catalog';
import { labelToId } from '../stepNames';
import { rectsOverlap, type Rect } from '../nodePlacement';

export const TEMPLATE_FORMAT_VERSION = 1;

/** The domains a template can belong to, with the words the gallery shows. */
export const TEMPLATE_DOMAINS: Record<string, string> = {
  qc: 'Read quality',
  dna: 'DNA sequencing',
  rna: 'RNA sequencing',
  epigenomics: 'Epigenomics',
  longread: 'Long reads',
  metagenomics: 'Metagenomics',
  general: 'General',
};

export type Difficulty = 'beginner' | 'intermediate' | 'advanced';

export const DIFFICULTIES: Record<Difficulty, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

/** Size assumed for a step when checking that a layout does not overlap, in canvas units. */
export const TEMPLATE_NODE_SIZE = { width: 200, height: 100 };

/** Where steps are spaced by default, so templates are written with the same grid. */
export const LAYOUT_PITCH = { x: 260, y: 160 };

export const MAX_STEPS = 60;
export const MAX_NAME_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 200;
export const MAX_DETAILS_LENGTH = 4000;

export interface TemplateInputTarget {
  /** The key of a step of this template. */
  step: string;
  /** The tool's input slot the file goes into. */
  slot: string;
}

export interface TemplateInput {
  id: string;
  /** What the setup step asks for: "Sequencing reads". */
  label: string;
  /** One or two short lines: what the file is, where it comes from. */
  hint: string;
  /** The file types it should be (from the catalog's file types). */
  types: string[];
  /** Several files can be given (one input of a sample set). */
  multiple: boolean;
  /** The run cannot start without it. An optional one may stay empty. */
  required: boolean;
  /** A file name shown as placeholder text. */
  example?: string;
  targets: TemplateInputTarget[];
}

export interface TemplateStep {
  /** Names the step inside the template; not shown to people. */
  key: string;
  /** A catalog tool id. */
  tool: string;
  /** The name on the canvas; the tool's name when absent. */
  label?: string;
  /** Option values; the tool's defaults apply to the rest. */
  params?: Record<string, ParamValue>;
  /** File names for slots: an output slot's file or folder, or a fixed input file. */
  files?: Record<string, string>;
  /** Where the step goes on the canvas, relative to the other steps. */
  position: { x: number; y: number };
}

export interface TemplateBinding {
  /** An input slot of the later step. */
  slot: string;
  /** An output slot of the earlier step. */
  output: string;
}

export interface TemplateEdge {
  from: string;
  to: string;
  /** The files that flow along it. Empty: the later step only runs after the earlier one. */
  bind?: TemplateBinding[];
}

export interface TemplateOutput {
  /** "Combined quality report". */
  label: string;
  step: string;
  /** The output slot of the step that holds it. */
  slot: string;
  hint?: string;
}

export interface TemplateReference {
  label: string;
  /** https only. */
  url?: string;
}

export interface WorkflowTemplate {
  formatVersion: number;
  id: string;
  name: string;
  description: string;
  details: string;
  domain: string;
  difficulty: Difficulty;
  minCatalogVersion: string;
  inputs: TemplateInput[];
  steps: TemplateStep[];
  edges: TemplateEdge[];
  outputs: TemplateOutput[];
  references: TemplateReference[];
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max;

/** The numbers of a dotted version ("2026.15.0" is [2026, 15, 0]), or null when it is not one. */
export function parseVersion(version: unknown): number[] | null {
  if (typeof version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(version.trim())) return null;
  return version.trim().split('.').map(Number);
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [];
  const y = parseVersion(b) ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True for an https address, the only kind the app opens. */
export function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The name each step gets on the canvas: its own label, or the tool's name;
 * when two steps would share a name (two FastQC steps without labels) the
 * later ones are numbered, like a tool added twice from the catalog.
 */
export function stepLabels(template: Pick<WorkflowTemplate, 'steps'>, catalog: Catalog = CATALOG): Record<string, string> {
  const taken = new Set<string>();
  const labels: Record<string, string> = {};
  for (const step of template.steps) {
    const tool = findTool(step.tool, catalog);
    const base = (typeof step.label === 'string' && step.label.trim()) || tool?.name || step.key;
    let label = base;
    for (let n = 2; taken.has(labelToId(label)); n++) label = `${base} ${n}`;
    taken.add(labelToId(label));
    labels[step.key] = label;
  }
  return labels;
}

/** The step keys of a graph in an order where every step comes after the ones it runs after, or null with a loop. */
export function topologicalOrder(keys: string[], edges: Array<{ from: string; to: string }>): string[] | null {
  const indegree = new Map(keys.map((k) => [k, 0]));
  for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const queue = keys.filter((k) => (indegree.get(k) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    order.push(key);
    for (const e of edges) {
      if (e.from !== key) continue;
      const left = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, left);
      if (left === 0) queue.push(e.to);
    }
  }
  return order.length === keys.length ? order : null;
}

/** The rectangle a step takes on the canvas, for the overlap check. */
export function stepRect(step: Pick<TemplateStep, 'position'>): Rect {
  return { x: step.position.x, y: step.position.y, ...TEMPLATE_NODE_SIZE };
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

export function paramProblem(tool: CatalogTool, id: string, value: unknown): string | null {
  const param = tool.params.find((p) => p.id === id);
  if (!param) return `${tool.name} has no option "${id}"`;
  switch (param.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `option "${id}" must be a number`;
      if (param.min !== undefined && value < param.min) return `option "${id}" is below its minimum ${param.min}`;
      if (param.max !== undefined && value > param.max) return `option "${id}" is above its maximum ${param.max}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `option "${id}" must be true or false`;
    case 'select':
      return typeof value === 'string' && param.options?.includes(value)
        ? null
        : `option "${id}" must be one of ${(param.options ?? []).join(', ')}`;
    case 'string':
      return typeof value === 'string' ? null : `option "${id}" must be text`;
  }
}

/**
 * Everything wrong with a template, as sentences for the person who wrote it
 * (empty when it is sound). It checks the shape, that every tool and slot
 * exists in the catalog, that every file a step needs is provided exactly
 * once (by a template input, by a connection or by a default file name), that
 * the steps form no loop and that no two steps share a spot on the canvas.
 */
export function validateTemplate(raw: unknown, catalog: Catalog = CATALOG): string[] {
  if (!isRecord(raw)) return ['The template is not a JSON object.'];
  const errors: string[] = [];
  const err = (message: string) => errors.push(message);

  if (raw.formatVersion !== TEMPLATE_FORMAT_VERSION) {
    err(`formatVersion must be ${TEMPLATE_FORMAT_VERSION}, this one says ${JSON.stringify(raw.formatVersion)}.`);
  }
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
    err('id must be lowercase letters, digits and dashes, starting with a letter or digit.');
  }
  if (!isText(raw.name, MAX_NAME_LENGTH)) err(`name is required (at most ${MAX_NAME_LENGTH} characters).`);
  if (!isText(raw.description, MAX_DESCRIPTION_LENGTH)) {
    err(`description is required (at most ${MAX_DESCRIPTION_LENGTH} characters).`);
  }
  if (!isText(raw.details, MAX_DETAILS_LENGTH)) err('details is required: say what the pipeline does.');
  if (typeof raw.domain !== 'string' || !(raw.domain in TEMPLATE_DOMAINS)) {
    err(`domain must be one of ${Object.keys(TEMPLATE_DOMAINS).join(', ')}.`);
  }
  if (typeof raw.difficulty !== 'string' || !(raw.difficulty in DIFFICULTIES)) {
    err(`difficulty must be one of ${Object.keys(DIFFICULTIES).join(', ')}.`);
  }
  if (parseVersion(raw.minCatalogVersion) === null) {
    err('minCatalogVersion must be a version like 2026.15.0.');
  } else if (compareVersions(raw.minCatalogVersion as string, catalog.version) > 0) {
    err(`This template needs tool catalog ${raw.minCatalogVersion} or newer; this app has ${catalog.version}.`);
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    err('steps must list at least one step.');
    return errors;
  }
  if (raw.steps.length > MAX_STEPS) err(`A template can have at most ${MAX_STEPS} steps.`);

  // ---- steps
  const steps: Array<{ key: string; tool: CatalogTool; step: TemplateStep }> = [];
  const keys = new Set<string>();
  for (const [i, item] of (raw.steps as unknown[]).entries()) {
    if (!isRecord(item)) {
      err(`Step ${i + 1} is not an object.`);
      continue;
    }
    const key = item.key;
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      err(`Step ${i + 1}: key must be lowercase letters, digits and underscores, starting with a letter.`);
      continue;
    }
    if (keys.has(key)) {
      err(`Two steps share the key "${key}".`);
      continue;
    }
    keys.add(key);
    const tool = findTool(item.tool, catalog);
    if (!tool) {
      err(`Step "${key}": the tool "${String(item.tool)}" is not in the tool catalog.`);
      continue;
    }
    if (item.label !== undefined && !isText(item.label, 60)) err(`Step "${key}": label must be 1 to 60 characters.`);
    const pos = item.position;
    if (!isRecord(pos) || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      err(`Step "${key}": position needs numbers x and y.`);
      continue;
    }
    if (item.params !== undefined) {
      if (!isRecord(item.params)) err(`Step "${key}": params must be an object.`);
      else {
        for (const [id, value] of Object.entries(item.params)) {
          const problem = paramProblem(tool, id, value);
          if (problem) err(`Step "${key}": ${problem}.`);
        }
      }
    }
    if (item.files !== undefined) {
      if (!isRecord(item.files)) err(`Step "${key}": files must be an object.`);
      else {
        for (const [slot, name] of Object.entries(item.files)) {
          const def = [...tool.inputs, ...tool.outputs].find((s) => s.name === slot);
          if (!def) err(`Step "${key}": ${tool.name} has no file slot "${slot}".`);
          else if ('derived' in def && def.derived) err(`Step "${key}": "${slot}" follows another output and cannot be set.`);
          else if (!isText(name, 300)) err(`Step "${key}": the file name for "${slot}" must be text.`);
        }
      }
    }
    steps.push({ key, tool, step: item as unknown as TemplateStep });
  }
  const byKey = new Map(steps.map((s) => [s.key, s]));

  // Names on the canvas must differ, and be usable as step ids.
  const labels = stepLabels({ steps: steps.map((s) => s.step) }, catalog);
  for (const s of steps) {
    if (labelToId(labels[s.key]) === '') err(`Step "${s.key}": its name needs at least one letter or number.`);
  }
  const seenLabels = new Map<string, string>();
  for (const s of steps) {
    const own = typeof s.step.label === 'string' ? labelToId(s.step.label) : '';
    if (own === '') continue;
    const other = seenLabels.get(own);
    if (other) err(`Steps "${other}" and "${s.key}" have the same name.`);
    seenLabels.set(own, s.key);
  }

  // ---- edges
  const bound = new Map<string, number>(); // `${step}|${slot}` -> how many connections fill it
  const edges: TemplateEdge[] = [];
  if (!Array.isArray(raw.edges)) err('edges must be a list (it may be empty).');
  for (const [i, item] of (Array.isArray(raw.edges) ? raw.edges : []).entries()) {
    if (!isRecord(item) || typeof item.from !== 'string' || typeof item.to !== 'string') {
      err(`Connection ${i + 1} needs "from" and "to".`);
      continue;
    }
    const from = byKey.get(item.from);
    const to = byKey.get(item.to);
    if (!from || !to) {
      err(`Connection ${item.from} to ${item.to} names a step that does not exist.`);
      continue;
    }
    if (item.from === item.to) {
      err(`Step "${item.from}" cannot run after itself.`);
      continue;
    }
    if (edges.some((e) => e.from === item.from && e.to === item.to)) {
      err(`The connection ${item.from} to ${item.to} appears twice.`);
      continue;
    }
    edges.push(item as unknown as TemplateEdge);
    for (const bind of Array.isArray(item.bind) ? item.bind : item.bind === undefined ? [] : [null]) {
      if (!isRecord(bind) || typeof bind.slot !== 'string' || typeof bind.output !== 'string') {
        err(`Connection ${item.from} to ${item.to}: each bind needs "slot" and "output".`);
        continue;
      }
      const slot = to.tool.inputs.find((s) => s.name === bind.slot);
      const out = from.tool.outputs.find((s) => s.name === bind.output);
      if (!slot) {
        err(`Connection ${item.from} to ${item.to}: ${to.tool.name} has no input "${bind.slot}".`);
        continue;
      }
      if (!out) {
        err(`Connection ${item.from} to ${item.to}: ${from.tool.name} has no output "${bind.output}".`);
        continue;
      }
      if (!typesFit(slot.types, out.types)) {
        err(
          `Connection ${item.from} to ${item.to}: "${out.label}" (${out.types.join(', ')}) does not fit "${slot.label}" (${slot.types.join(', ')}).`
        );
      }
      const id = `${to.key}|${slot.name}`;
      bound.set(id, (bound.get(id) ?? 0) + 1);
    }
  }
  if (topologicalOrder([...byKey.keys()], edges) === null) err('The connections form a loop; steps must run in one direction.');

  // ---- inputs
  const inputIds = new Set<string>();
  const provided = new Map<string, number>(); // `${step}|${slot}` -> how many template inputs fill it
  if (!Array.isArray(raw.inputs)) err('inputs must be a list (it may be empty).');
  for (const [i, item] of (Array.isArray(raw.inputs) ? raw.inputs : []).entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || !KEY_PATTERN.test(item.id)) {
      err(`Input ${i + 1}: id must be lowercase letters, digits and underscores, starting with a letter.`);
      continue;
    }
    const name = `Input "${item.id}"`;
    if (inputIds.has(item.id)) err(`${name} appears twice.`);
    inputIds.add(item.id);
    if (!isText(item.label, 80)) err(`${name}: label is required.`);
    if (typeof item.hint !== 'string') err(`${name}: hint must be text (it may be empty).`);
    if (typeof item.multiple !== 'boolean') err(`${name}: multiple must be true or false.`);
    if (typeof item.required !== 'boolean') err(`${name}: required must be true or false.`);
    if (item.example !== undefined && typeof item.example !== 'string') err(`${name}: example must be text.`);
    const types = Array.isArray(item.types) ? item.types : [];
    if (types.length === 0 || types.some((t) => typeof t !== 'string' || (t !== 'any' && !catalog.file_types.includes(t)))) {
      err(`${name}: types must list file types from the catalog.`);
    }
    if (!Array.isArray(item.targets) || item.targets.length === 0) {
      err(`${name}: targets must name at least one step slot.`);
      continue;
    }
    for (const target of item.targets) {
      if (!isRecord(target) || typeof target.step !== 'string' || typeof target.slot !== 'string') {
        err(`${name}: each target needs "step" and "slot".`);
        continue;
      }
      const step = byKey.get(target.step);
      const slot = step?.tool.inputs.find((s) => s.name === target.slot);
      if (!step || !slot) {
        err(`${name}: ${target.step}.${target.slot} is not an input slot of a step.`);
        continue;
      }
      if (item.multiple === true && !slot.multiple) {
        err(`${name} takes several files but ${step.tool.name} "${slot.label}" takes one.`);
      }
      if (item.required === false && slot.required) {
        err(`${name} is optional but ${step.tool.name} needs "${slot.label}" to run.`);
      }
      if (types.every((t) => typeof t === 'string') && !typesFit(slot.types, types as string[])) {
        err(`${name} (${types.join(', ')}) does not fit ${step.tool.name} "${slot.label}" (${slot.types.join(', ')}).`);
      }
      const id = `${step.key}|${slot.name}`;
      provided.set(id, (provided.get(id) ?? 0) + 1);
    }
  }

  // ---- every slot a step needs has a source
  for (const s of steps) {
    const fixed = isRecord(s.step.files) ? s.step.files : {};
    for (const slot of s.tool.inputs) {
      const id = `${s.key}|${slot.name}`;
      const sources = (bound.get(id) ?? 0) + (provided.get(id) ?? 0) + (typeof fixed[slot.name] === 'string' ? 1 : 0);
      if (sources === 0 && slot.required) {
        err(`Step "${s.key}": "${slot.label}" gets no file. Connect a step, add a template input or give it a default.`);
      }
      if (sources > 1 && !slot.multiple) {
        err(`Step "${s.key}": "${slot.label}" takes one file but is filled in ${sources} ways.`);
      }
    }
    const missing = missingRequiredParams(s.tool, { ...Object.fromEntries(s.tool.params.map((p) => [p.id, p.default])), ...(isRecord(s.step.params) ? s.step.params : {}) });
    for (const id of missing) {
      err(`Step "${s.key}": the option "${s.tool.params.find((p) => p.id === id)?.label ?? id}" must be filled in.`);
    }
  }

  // ---- layout
  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      if (rectsOverlap(stepRect(steps[i].step), stepRect(steps[j].step))) {
        err(`Steps "${steps[i].key}" and "${steps[j].key}" overlap on the canvas. Move one.`);
      }
    }
  }

  // ---- outputs and references
  if (!Array.isArray(raw.outputs)) err('outputs must be a list (it may be empty).');
  for (const [i, item] of (Array.isArray(raw.outputs) ? raw.outputs : []).entries()) {
    if (!isRecord(item) || !isText(item.label, 120) || typeof item.step !== 'string' || typeof item.slot !== 'string') {
      err(`Output ${i + 1} needs a label, a step and a slot.`);
      continue;
    }
    const step = byKey.get(item.step);
    if (!step || !step.tool.outputs.some((s) => s.name === item.slot)) {
      err(`Output "${item.label}": ${item.step}.${item.slot} is not an output of a step.`);
    }
    if (item.hint !== undefined && typeof item.hint !== 'string') err(`Output "${item.label}": hint must be text.`);
  }
  if (!Array.isArray(raw.references)) err('references must be a list (it may be empty).');
  for (const [i, item] of (Array.isArray(raw.references) ? raw.references : []).entries()) {
    if (!isRecord(item) || !isText(item.label, 300)) {
      err(`Reference ${i + 1} needs a label.`);
      continue;
    }
    if (item.url !== undefined && !isHttpsUrl(item.url)) err(`Reference "${item.label}": url must start with https://.`);
  }

  return errors;
}

/** The template, typed, when it is valid; otherwise the problems. */
export function parseTemplate(
  raw: unknown,
  catalog: Catalog = CATALOG
): { ok: true; template: WorkflowTemplate } | { ok: false; errors: string[] } {
  const errors = validateTemplate(raw, catalog);
  return errors.length === 0 ? { ok: true, template: raw as WorkflowTemplate } : { ok: false, errors };
}

/** Tool names of a template for display, in step order, without repeats. */
export function toolsUsed(template: Pick<WorkflowTemplate, 'steps'>, catalog: Catalog = CATALOG): string[] {
  const names: string[] = [];
  for (const step of template.steps) {
    const tool = findTool(step.tool, catalog);
    const name = tool ? tool.name : step.tool;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface DatabaseNeed {
  tool: string;
  label: string;
  hint: string;
  link?: { label: string; url: string };
}

/** The databases the template's tools need set up first, one per tool. */
export function databaseNeeds(template: Pick<WorkflowTemplate, 'steps'>, catalog: Catalog = CATALOG): DatabaseNeed[] {
  const needs: DatabaseNeed[] = [];
  for (const step of template.steps) {
    const tool = findTool(step.tool, catalog);
    if (!tool?.needs_database || needs.some((n) => n.tool === tool.name)) continue;
    needs.push({ tool: tool.name, ...tool.needs_database });
  }
  return needs;
}
