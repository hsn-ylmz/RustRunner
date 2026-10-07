/**
 * "Save as template": turning the steps on the canvas into a template.
 *
 * Only a workflow made entirely of catalog steps can become a template: a
 * template holds tools and options, never a command, so a step written by hand
 * (or a catalog step whose command was edited) has nothing to be rebuilt from.
 * `templateBlockers` says which steps stand in the way.
 *
 * The person decides which files become template inputs, the ones asked for
 * each time the template is used. Every other file that a step holds (a typed
 * input file, an output name) stays in the template as its default.
 * Pure: no React, no Electron.
 */

import {
  CATALOG,
  catalogToolName,
  defaultParams,
  findTool,
  type Catalog,
} from '../tools/catalog';
import { labelToId } from '../stepNames';
import { slotLinksOf, slotStates, slotFilesOf, slotDefsFor, type SlotDef } from '../slots';
import {
  DIFFICULTIES,
  LAYOUT_PITCH,
  TEMPLATE_FORMAT_VERSION,
  paramProblem,
  parseTemplate,
  stepRect,
  type TemplateEdge,
  type TemplateInput,
  type TemplateOutput,
  type TemplateStep,
  type WorkflowTemplate,
} from './schema';
import { rectsOverlap } from '../nodePlacement';

/** Why the workflow cannot become a template, one sentence per step in the way. Empty when it can. */
export function templateBlockers(nodes: any[], catalog: Catalog = CATALOG): string[] {
  if (nodes.length === 0) return ['Add some steps first.'];
  const reasons: string[] = [];
  for (const node of nodes) {
    const data = node.data ?? {};
    const name = (typeof data.label === 'string' && data.label.trim()) || 'An unnamed step';
    const tool = findTool(data.catalogId, catalog);
    if (!tool) {
      reasons.push(`"${name}" is a custom step. Templates can hold catalog tools only.`);
    } else if (data.catalogCommandCustom === true || data.tool !== catalogToolName(tool)) {
      reasons.push(`"${name}" has a command you edited by hand. Rebuild it from its options first.`);
    }
  }
  return reasons;
}

/** A file slot that could be asked for each time the template is used. */
export interface InputCandidate {
  /** `<node id>|<slot id>` */
  id: string;
  nodeId: string;
  stepLabel: string;
  slotId: string;
  slotLabel: string;
  types: string[];
  required: boolean;
  multiple: boolean;
  /** The file names typed in the slot now ('' when empty). */
  value: string;
}

/** The slots of catalog steps that no connection fills: the places a person's own files go. */
export function inputCandidates(nodes: any[], edges: any[], catalog: Catalog = CATALOG): InputCandidate[] {
  const out: InputCandidate[] = [];
  for (const node of nodes) {
    if (!findTool(node.data?.catalogId, catalog)) continue;
    for (const state of slotStates(node, nodes, edges, catalog)) {
      if (state.def.kind !== 'input' || state.links.length > 0) continue;
      out.push({
        id: `${node.id}|${state.def.id}`,
        nodeId: node.id,
        stepLabel: (node.data?.label ?? '').trim() || 'Unnamed step',
        slotId: state.def.id,
        slotLabel: state.def.label,
        types: state.def.types,
        required: state.def.required,
        multiple: state.def.multiple,
        value: state.value.trim(),
      });
    }
  }
  return out;
}

/** Candidates that hold the same file now: one question to the person, not several. */
export interface CandidateGroup {
  id: string;
  candidates: InputCandidate[];
  /** The label to start from: the slot's, with the step's name when slots of different steps differ. */
  label: string;
  /** Some slot in the group cannot run without a file. */
  required: boolean;
  /** A required slot with no file: it must be asked for, the template has nothing to fall back on. */
  mustAsk: boolean;
}

export function groupCandidates(candidates: InputCandidate[]): CandidateGroup[] {
  const groups: CandidateGroup[] = [];
  for (const c of candidates) {
    const same = c.value === '' ? undefined : groups.find((g) => g.candidates[0].value === c.value);
    if (same) same.candidates.push(c);
    else groups.push({ id: c.id, candidates: [c], label: '', required: false, mustAsk: false });
  }
  const labelCount = new Map<string, number>();
  for (const g of groups) labelCount.set(g.candidates[0].slotLabel, (labelCount.get(g.candidates[0].slotLabel) ?? 0) + 1);
  for (const g of groups) {
    const first = g.candidates[0];
    g.label = (labelCount.get(first.slotLabel) ?? 0) > 1 ? `${first.slotLabel} for ${first.stepLabel}` : first.slotLabel;
    g.required = g.candidates.some((c) => c.required);
    g.mustAsk = g.required && first.value === '';
  }
  return groups;
}

export interface TemplateDraft {
  name: string;
  description: string;
  /** Optional longer text; a plain summary is written when empty. */
  details?: string;
  domain?: string;
  difficulty?: keyof typeof DIFFICULTIES;
  /** The files to ask for: which slots each one fills, and how to word the question. */
  inputs: Array<{ candidateIds: string[]; label: string; hint?: string }>;
}

/** Positions that cannot overlap: steps in layers (a step is one layer below the deepest step before it). */
export function autoLayout(keys: string[], edges: Array<{ from: string; to: string }>): Record<string, { x: number; y: number }> {
  const layer = new Map<string, number>(keys.map((k) => [k, 0]));
  // Keys are given in dependency order by the caller or not; relax until stable (the graph is acyclic).
  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const next = (layer.get(e.from) ?? 0) + 1;
      if (next > (layer.get(e.to) ?? 0)) {
        layer.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const used = new Map<number, number>();
  const out: Record<string, { x: number; y: number }> = {};
  for (const key of keys) {
    const l = layer.get(key) ?? 0;
    const i = used.get(l) ?? 0;
    used.set(l, i + 1);
    out[key] = { x: i * LAYOUT_PITCH.x, y: l * LAYOUT_PITCH.y };
  }
  return out;
}

function stepKeys(nodes: any[]): Map<string, string> {
  const keys = new Map<string, string>();
  const taken = new Set<string>();
  for (const node of nodes) {
    let base = labelToId(node.data?.label ?? '') || 'step';
    if (!/^[a-z]/.test(base)) base = `s_${base}`;
    base = base.slice(0, 34);
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
    taken.add(key);
    keys.set(node.id, key);
  }
  return keys;
}

/** A readable id for a new user template: the name, plus a short code so two saves never collide. */
export function newTemplateId(name: string, now: number = Date.now()): string {
  const slug = labelToId(name).replace(/_/g, '-').slice(0, 40).replace(/-+$/g, '') || 'template';
  return `${slug}-${now.toString(36)}`;
}

/**
 * The template for the steps on the canvas. Fails with sentences when a step
 * cannot be part of a template or the result would not work (a step left
 * without a file, say).
 */
export function buildUserTemplate(
  nodes: any[],
  edges: any[],
  draft: TemplateDraft,
  catalog: Catalog = CATALOG,
  now: number = Date.now()
): { ok: true; template: WorkflowTemplate } | { ok: false; errors: string[] } {
  const blockers = templateBlockers(nodes, catalog);
  if (blockers.length > 0) return { ok: false, errors: blockers };

  const keys = stepKeys(nodes);
  const candidates = new Map(inputCandidates(nodes, edges, catalog).map((c) => [c.id, c]));
  const asked = new Set(draft.inputs.flatMap((i) => i.candidateIds));
  const key = (id: string) => keys.get(id)!;

  // ---- steps
  const steps: TemplateStep[] = nodes.map((node) => {
    const data = node.data ?? {};
    const tool = findTool(data.catalogId, catalog)!;
    const defaults = defaultParams(tool);
    const params: Record<string, any> = {};
    for (const [id, value] of Object.entries<any>(data.catalogParams ?? {})) {
      if (paramProblem(tool, id, value) === null && value !== defaults[id]) params[id] = value;
    }
    const files: Record<string, string> = {};
    const defs: SlotDef[] = slotDefsFor(data, catalog);
    const links = slotLinksOf(data);
    for (const [slot, value] of Object.entries(slotFilesOf(data))) {
      const def = defs.find((d) => d.id === slot);
      const text = value.trim();
      if (!def || def.derived || text === '') continue;
      if (def.kind === 'input' && (asked.has(`${node.id}|${slot}`) || (links[slot] ?? []).length > 0)) continue;
      files[slot] = text;
    }
    const step: TemplateStep = {
      key: key(node.id),
      tool: tool.id,
      label: (data.label ?? '').trim() || undefined,
      position: { x: Math.round(node.position?.x ?? 0), y: Math.round(node.position?.y ?? 0) },
    };
    if (Object.keys(params).length > 0) step.params = params;
    if (Object.keys(files).length > 0) step.files = files;
    if (!step.label) delete step.label;
    return step;
  });

  // ---- connections
  const templateEdges: TemplateEdge[] = [];
  for (const edge of edges) {
    const source = nodes.find((n) => n.id === edge.source);
    const target = nodes.find((n) => n.id === edge.target);
    if (!source || !target) continue;
    const sourceTool = findTool(source.data.catalogId, catalog)!;
    const bind: Array<{ slot: string; output: string }> = [];
    for (const [slot, list] of Object.entries(slotLinksOf(target.data))) {
      for (const link of list) {
        if (link.from === source.id && sourceTool.outputs.some((o) => o.name === link.output)) {
          bind.push({ slot, output: link.output });
        }
      }
    }
    templateEdges.push({ from: key(source.id), to: key(target.id), ...(bind.length > 0 ? { bind } : {}) });
  }

  // ---- layout: keep the person's arrangement unless steps would overlap
  const overlaps = steps.some((a, i) => steps.slice(i + 1).some((b) => rectsOverlap(stepRect(a), stepRect(b))));
  if (overlaps) {
    const spots = autoLayout(
      steps.map((s) => s.key),
      templateEdges
    );
    for (const s of steps) s.position = spots[s.key];
  }

  // ---- inputs
  const inputs: TemplateInput[] = [];
  const usedIds = new Set<string>();
  for (const [i, wanted] of draft.inputs.entries()) {
    const picked = wanted.candidateIds.map((id) => candidates.get(id)).filter((c): c is InputCandidate => Boolean(c));
    if (picked.length === 0) continue;
    let id = labelToId(wanted.label).slice(0, 30) || `input_${i + 1}`;
    if (!/^[a-z]/.test(id)) id = `input_${id}`;
    for (let n = 2; usedIds.has(id); n++) id = `${id.replace(/_\d+$/, '')}_${n}`;
    usedIds.add(id);
    const types = [...new Set(picked.flatMap((c) => c.types))];
    const example = picked[0].value.split(',')[0]?.trim().split(/[\\/]/).pop();
    inputs.push({
      id,
      label: wanted.label.trim() || picked[0].slotLabel,
      hint: (wanted.hint ?? '').trim(),
      types: types.length > 0 ? types : ['any'],
      multiple: picked.every((c) => c.multiple),
      required: picked.some((c) => c.required),
      ...(example ? { example } : {}),
      targets: picked.map((c) => ({ step: key(c.nodeId), slot: c.slotId })),
    });
  }

  // ---- what the pipeline makes: the output files of the last steps
  const outputs: TemplateOutput[] = [];
  for (const node of nodes) {
    if (edges.some((e) => e.source === node.id)) continue;
    const tool = findTool(node.data.catalogId, catalog)!;
    for (const out of tool.outputs) {
      if (out.derived && out.is_dir) continue;
      if (outputs.length >= 6) break;
      outputs.push({ label: `${out.label} (${(node.data.label ?? tool.name).trim()})`, step: key(node.id), slot: out.name });
    }
  }

  const names = steps.map((s) => s.label ?? s.tool);
  const draftTemplate: WorkflowTemplate = {
    formatVersion: TEMPLATE_FORMAT_VERSION,
    id: newTemplateId(draft.name, now),
    name: draft.name.trim(),
    description: draft.description.trim() || `Your workflow with ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}.`,
    details: (draft.details ?? '').trim() || `Saved from your own workflow. Steps: ${names.join(', ')}.`,
    domain: draft.domain ?? 'general',
    difficulty: draft.difficulty ?? 'intermediate',
    minCatalogVersion: catalog.version,
    inputs,
    steps,
    edges: templateEdges,
    outputs,
    references: [],
  };
  return parseTemplate(draftTemplate, catalog);
}
