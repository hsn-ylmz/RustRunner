/**
 * Named file slots: the files a command names with `{placeholders}` besides the
 * main input and output (a reference genome, the two read files of a pair, the
 * `.bai` that goes with a `.bam`).
 *
 * A slot comes from the tool catalog (a tool declares `inputSlots` and
 * `outputSlots`) or, for a step written by hand, from the placeholders found in
 * its command. Each slot is shown as a labelled file field. It holds either a
 * file name the person typed or a link to an output of a step that runs before
 * this one; connecting two steps fills a free slot of the later step with a
 * matching output of the earlier one.
 *
 * Everything here is pure (no React, no Electron) so it is unit-tested. The
 * command scanner mirrors the engine's (`RustRunner/src/workflow/slots.rs`), so
 * the editor and the engine agree on which placeholders a command holds.
 *
 * Node data used (all optional, so older workflow files load unchanged):
 *   slotFiles  { slotId: "a.fa, b.fa" }        what was typed for each slot
 *   slotLinks  { slotId: { from, output } }    a slot filled from another step
 *   slotKinds  { slotId: 'input' | 'output' }  the role of a hand-written slot
 */

import { CATALOG, findTool, shellQuote, type Catalog, type CatalogSlot } from './tools/catalog';
import { declaredOutputs, normalizeWildcardName } from './stepNames';

// -----------------------------------------------------------------------------
// Reading a command
// -----------------------------------------------------------------------------

/** Placeholders the engine fills for every step; they never become slots. */
export const BUILTIN_PLACEHOLDERS = ['input', 'output', 'inputs', 'outputs', 'threads'];

/** Longest slot name the engine accepts (`MAX_SLOT_NAME_LEN` in slots.rs). */
export const MAX_SLOT_NAME_LENGTH = 40;

export type Quote = 'none' | 'single' | 'double' | 'ansi';

export type CommandPart =
  | { kind: 'text'; text: string }
  | { kind: 'hole'; name: string; quote: Quote; problem?: string };

const PROBLEM_ANSI = "it is inside a $'...' string";
const PROBLEM_HEREDOC = 'it follows a here-document (<<)';
const PROBLEM_NESTED = 'it follows a double-quoted string that also holds $(...) or a backtick';

const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);
const isIdentifier = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/** `{identifier}` starting at `i`: the name and the index after the closing brace. */
function braceName(text: string, i: number): { name: string; end: number } | null {
  if (text[i] !== '{') return null;
  let name = '';
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '}') return isIdentifier(name) ? { name, end: j + 1 } : null;
    if (!isNameChar(c)) return null;
    name += c;
  }
  return null;
}

/**
 * Splits a command into plain text and `{name}` placeholders, tracking the
 * shell quoting around each one. Placeholders inside `#` comments, `${...}`
 * and `{{name}}` escapes (literal `{name}`) are not placeholders.
 */
export function scanCommand(command: string): CommandPart[] {
  const parts: CommandPart[] = [];
  let text = '';
  let quote: Quote = 'none';
  let sticky: string | undefined;
  let inComment = false;
  let wordStart = true;
  let i = 0;
  const n = command.length;

  while (i < n) {
    const c = command[i];
    const next: string | undefined = command[i + 1];

    if (inComment) {
      text += c;
      if (c === '\n') {
        inComment = false;
        wordStart = true;
      }
      i++;
      continue;
    }

    if (c === '\\' && quote !== 'single') {
      text += c;
      if (next !== undefined) text += next;
      i += 2;
      wordStart = false;
      continue;
    }

    if (c === '$' && next === '{' && quote !== 'single') {
      let depth = 0;
      while (i < n) {
        text += command[i];
        if (command[i] === '{') depth++;
        else if (command[i] === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      wordStart = false;
      continue;
    }

    if (quote === 'double' && (c === '`' || (c === '$' && next === '('))) {
      sticky = sticky ?? PROBLEM_NESTED;
    }

    if (c === '{') {
      if (next === '{') {
        const inner = braceName(command, i + 1);
        if (inner && command[inner.end] === '}') {
          text += `{${inner.name}}`;
          i = inner.end + 1;
          wordStart = false;
          continue;
        }
      }
      const hole = braceName(command, i);
      if (hole) {
        if (text) parts.push({ kind: 'text', text });
        text = '';
        parts.push({
          kind: 'hole',
          name: hole.name,
          quote,
          problem: quote === 'ansi' ? PROBLEM_ANSI : sticky,
        });
        i = hole.end;
        wordStart = false;
        continue;
      }
    }

    if (quote === 'single' || quote === 'ansi') {
      if (c === "'") quote = 'none';
    } else if (quote === 'double') {
      if (c === '"') quote = 'none';
    } else if (c === "'") {
      quote = 'single';
    } else if (c === '"') {
      quote = 'double';
    } else if (c === '$' && next === "'") {
      text += "$'";
      quote = 'ansi';
      i += 2;
      wordStart = false;
      continue;
    } else if (c === '#' && wordStart) {
      inComment = true;
    } else if (c === '<' && next === '<' && command[i + 2] !== '<' && (i === 0 || command[i - 1] !== '<')) {
      sticky = sticky ?? PROBLEM_HEREDOC;
    }
    wordStart = quote === 'none' && (/\s/.test(c) || ';&|()'.includes(c));
    text += c;
    i++;
  }
  if (text) parts.push({ kind: 'text', text });
  return parts;
}

/** The placeholder names a command uses, in order of first use, without repeats. */
export function placeholderNames(command: string): string[] {
  const names: string[] = [];
  for (const part of scanCommand(command)) {
    if (part.kind === 'hole' && !names.includes(part.name)) names.push(part.name);
  }
  return names;
}

/** In a step without slots the engine keeps `{{x}}` as typed; the editor writes it as `{x}` there. */
export function unescapeBraces(command: string): string {
  return command.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, '{$1}');
}

// -----------------------------------------------------------------------------
// File types
// -----------------------------------------------------------------------------

const EXTENSION_TYPES: Record<string, string> = {
  fastq: 'fastq',
  fq: 'fastq',
  fasta: 'fasta',
  fa: 'fasta',
  fna: 'fasta',
  ffn: 'fasta',
  sam: 'sam',
  bam: 'bam',
  bai: 'bai',
  vcf: 'vcf',
  gtf: 'gtf',
  gff: 'gtf',
  gff3: 'gtf',
  tsv: 'tsv',
  csv: 'tsv',
  txt: 'txt',
  html: 'html',
  zip: 'zip',
};

/** The file type a path's extension names (`reads.fq.gz` is fastq), or none. */
export function typesOfPath(path: string): string[] {
  const base = path.trim().split(/[\\/]/).pop() ?? '';
  const parts = base.toLowerCase().split('.');
  while (parts.length > 1 && ['gz', 'bz2', 'zst', 'xz'].includes(parts[parts.length - 1])) parts.pop();
  const type = parts.length > 1 ? EXTENSION_TYPES[parts[parts.length - 1]] : undefined;
  return type ? [type] : [];
}

/** The file types of a list of paths, without repeats. */
export function typesOfPaths(paths: string[]): string[] {
  const types: string[] = [];
  for (const path of paths) for (const t of typesOfPath(path)) if (!types.includes(t)) types.push(t);
  return types;
}

const intersects = (a: string[], b: string[]) => a.some((t) => b.includes(t));

// -----------------------------------------------------------------------------
// Slots of a step
// -----------------------------------------------------------------------------

export type SlotKind = 'input' | 'output';

export interface SlotDef {
  /** The placeholder name used in the command. */
  id: string;
  kind: SlotKind;
  /** What the person sees above the field. */
  label: string;
  /** File types it takes or makes; empty when unknown. */
  types: string[];
  /** One or two short lines under the field. */
  hint: string;
  fromCatalog: boolean;
}

/** What `{ref}`-style names usually mean, so a hand-written step gets a plain label and a type. */
const WELL_KNOWN: Record<string, { label: string; types: string[] }> = {
  ref: { label: 'Reference genome', types: ['fasta'] },
  reference: { label: 'Reference genome', types: ['fasta'] },
  genome: { label: 'Reference genome', types: ['fasta'] },
  fasta: { label: 'FASTA file', types: ['fasta'] },
  reads: { label: 'Reads', types: ['fastq'] },
  reads1: { label: 'Reads, first of the pair', types: ['fastq'] },
  reads2: { label: 'Reads, second of the pair', types: ['fastq'] },
  read1: { label: 'Reads, first of the pair', types: ['fastq'] },
  read2: { label: 'Reads, second of the pair', types: ['fastq'] },
  r1: { label: 'Reads, first of the pair', types: ['fastq'] },
  r2: { label: 'Reads, second of the pair', types: ['fastq'] },
  fastq: { label: 'Reads', types: ['fastq'] },
  sam: { label: 'SAM file', types: ['sam'] },
  bam: { label: 'BAM file', types: ['bam'] },
  bai: { label: 'BAM index', types: ['bai'] },
  vcf: { label: 'Variants (VCF)', types: ['vcf'] },
  gtf: { label: 'Gene annotation', types: ['gtf'] },
  annotation: { label: 'Gene annotation', types: ['gtf'] },
};

/** "my_bam_file" -> "My bam file". */
function humanize(id: string): string {
  const words = id.replace(/_+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}

function hintFor(id: string, types: string[], extra?: string): string {
  const parts = [extra, `Written as {${id}} in the command.`];
  if (types.length > 0) parts.push(`File type: ${types.join(' or ')}.`);
  return parts.filter(Boolean).join(' ');
}

function catalogDef(slot: CatalogSlot, kind: SlotKind): SlotDef {
  return {
    id: slot.id,
    kind,
    label: slot.label,
    types: slot.types,
    hint: hintFor(slot.id, slot.types, slot.description),
    fromCatalog: true,
  };
}

function derivedDef(id: string, kind: SlotKind): SlotDef {
  const known = WELL_KNOWN[id.toLowerCase()];
  const types = known?.types ?? [];
  return {
    id,
    kind,
    label: known?.label ?? humanize(id),
    types,
    hint: hintFor(id, types),
    fromCatalog: false,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What was typed for each slot (older files have none). */
export function slotFilesOf(data: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(data?.slotFiles)) {
    for (const [id, value] of Object.entries(data.slotFiles)) {
      if (typeof value === 'string') out[id] = value;
    }
  }
  return out;
}

export interface SlotLink {
  /** Canvas id of the step the file comes from. */
  from: string;
  /** Which of its outputs: '' is its main output, else the id of a named output. */
  output: string;
}

/** The links of a node, dropping entries that are not well-formed. */
export function slotLinksOf(data: any): Record<string, SlotLink> {
  const out: Record<string, SlotLink> = {};
  if (isRecord(data?.slotLinks)) {
    for (const [id, link] of Object.entries(data.slotLinks)) {
      if (isRecord(link) && typeof link.from === 'string' && typeof link.output === 'string') {
        out[id] = { from: link.from, output: link.output };
      }
    }
  }
  return out;
}

function slotKindsOf(data: any): Record<string, SlotKind> {
  const out: Record<string, SlotKind> = {};
  if (isRecord(data?.slotKinds)) {
    for (const [id, kind] of Object.entries(data.slotKinds)) {
      if (kind === 'input' || kind === 'output') out[id] = kind;
    }
  }
  return out;
}

/**
 * The slots of a step, in the order the command first uses them (catalog steps:
 * the order the tool declares them). A catalog step keeps to what its tool
 * declares while its command is generated; once the command is edited by hand,
 * or for a step that never came from the catalog, every `{name}` in the command
 * is a slot except the built-in placeholders and the step's own batch-file name.
 */
export function slotDefsFor(data: any, catalog: Catalog = CATALOG): SlotDef[] {
  const tool = findTool(data?.catalogId, catalog);
  const declared: SlotDef[] = tool
    ? [
        ...(tool.inputSlots ?? []).map((s) => catalogDef(s, 'input')),
        ...(tool.outputSlots ?? []).map((s) => catalogDef(s, 'output')),
      ]
    : [];
  if (tool && data?.catalogCommandCustom !== true) return declared;

  const wildcard = normalizeWildcardName(data?.wildcardName);
  const kinds = slotKindsOf(data);
  const command = typeof data?.command === 'string' ? data.command : '';
  return placeholderNames(command)
    .filter((name) => !BUILTIN_PLACEHOLDERS.includes(name.toLowerCase()) && name !== wildcard)
    .map((name) => {
      const known = declared.find((d) => d.id === name);
      if (known) return known;
      return derivedDef(name, kinds[name] ?? 'input');
    });
}

// -----------------------------------------------------------------------------
// Outputs a step offers to the steps after it
// -----------------------------------------------------------------------------

export interface OutputItem {
  /** '' for the main output, else the id of a named output. */
  key: string;
  /** "Output file" or the named output's label. */
  label: string;
  files: string[];
  types: string[];
}

/**
 * What a step makes: its main output and each named output that has a file.
 * `includeEmpty` also lists the ones with no file yet (to describe a link whose
 * source has not been filled in).
 */
export function outputItems(
  node: any,
  catalog: Catalog = CATALOG,
  includeEmpty = false
): OutputItem[] {
  const data = node?.data ?? {};
  const tool = findTool(data.catalogId, catalog);
  const items: OutputItem[] = [];

  const main = declaredOutputs(data.output);
  if (main.length > 0 || includeEmpty) {
    items.push({
      key: '',
      label: 'Output file',
      files: main,
      types: tool ? tool.outputTypes : typesOfPaths(main),
    });
  }
  const typed = slotFilesOf(data);
  for (const def of slotDefsFor(data, catalog)) {
    if (def.kind !== 'output') continue;
    const files = declaredOutputs(typed[def.id]);
    if (files.length === 0 && !includeEmpty) continue;
    items.push({
      key: def.id,
      label: def.label,
      files,
      types: def.types.length > 0 ? def.types : typesOfPaths(files),
    });
  }
  return items;
}

// -----------------------------------------------------------------------------
// What each slot holds
// -----------------------------------------------------------------------------

export interface GraphNodeLike {
  id: string;
  data?: any;
}

export interface GraphEdgeLike {
  source: string;
  target: string;
}

export interface SlotState {
  def: SlotDef;
  /** What was typed (kept while the slot is linked, so Unlink can start from it). */
  value: string;
  /** Set when the slot takes its file from a step that still runs before this one. */
  link: { nodeId: string; stepLabel: string; outputLabel: string } | null;
  /** The files the engine gets for this slot. */
  files: string[];
}

function stepLabelOf(node: GraphNodeLike | undefined): string {
  const label = typeof node?.data?.label === 'string' ? node.data.label.trim() : '';
  return label || 'Unnamed step';
}

/** A link counts while its connection exists and its source step is still on the canvas. */
function liveLink(
  link: SlotLink | undefined,
  nodeId: string,
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>
): GraphNodeLike | undefined {
  if (!link) return undefined;
  if (!edges.some((e) => e.source === link.from && e.target === nodeId)) return undefined;
  return nodes.find((n) => n.id === link.from);
}

export function slotStates(
  node: GraphNodeLike,
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>,
  catalog: Catalog = CATALOG
): SlotState[] {
  const typed = slotFilesOf(node.data);
  const links = slotLinksOf(node.data);
  return slotDefsFor(node.data, catalog).map((def) => {
    const value = typed[def.id] ?? '';
    const source = def.kind === 'input' ? liveLink(links[def.id], node.id, nodes, edges) : undefined;
    if (source) {
      const item = outputItems(source, catalog, true).find((o) => o.key === links[def.id].output);
      return {
        def,
        value,
        link: {
          nodeId: source.id,
          stepLabel: stepLabelOf(source),
          outputLabel: item?.label ?? 'Output file',
        },
        files: item?.files ?? [],
      };
    }
    return { def, value, link: null, files: declaredOutputs(value) };
  });
}

// -----------------------------------------------------------------------------
// Binding on connect
// -----------------------------------------------------------------------------

export interface BindingOption {
  /** The slot of the later step that would receive the file. */
  slot: string;
  slotLabel: string;
  /** Which output of the earlier step: '' main, else a named output. */
  outputKey: string;
  outputLabel: string;
  files: string[];
  /** Both ends declare file types and they agree. */
  typeMatch: boolean;
}

export type BindingPlan =
  | { kind: 'none' }
  | { kind: 'auto'; option: BindingOption }
  | { kind: 'ask'; options: BindingOption[] };

/**
 * What connecting `sourceId` into `targetId` should do about slots.
 *
 * Only a free input slot (no typed file, no link) of the later step can be
 * filled, and only from an output of the earlier step that has a file. The
 * pairs whose file types agree come first: one such pair is bound without
 * asking, several are put to the person. With no agreeing pair, a free slot
 * whose type is unknown (or an output whose type is unknown) takes the first
 * output, in slot order; a slot whose type is known and different is left
 * alone. When that slot could take several outputs the person is asked.
 */
export function planBinding(
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>,
  sourceId: string,
  targetId: string,
  catalog: Catalog = CATALOG
): BindingPlan {
  const source = nodes.find((n) => n.id === sourceId);
  const target = nodes.find((n) => n.id === targetId);
  if (!source || !target || sourceId === targetId) return { kind: 'none' };

  const free = slotStates(target, nodes, edges, catalog).filter(
    (s) => s.def.kind === 'input' && s.link === null && s.value.trim() === ''
  );
  const outputs = outputItems(source, catalog);
  if (free.length === 0 || outputs.length === 0) return { kind: 'none' };

  const pair = (slot: SlotState, out: OutputItem): BindingOption => ({
    slot: slot.def.id,
    slotLabel: slot.def.label,
    outputKey: out.key,
    outputLabel: out.label,
    files: out.files,
    typeMatch: slot.def.types.length > 0 && out.types.length > 0 && intersects(slot.def.types, out.types),
  });

  const matching: BindingOption[] = [];
  for (const slot of free) for (const out of outputs) if (pair(slot, out).typeMatch) matching.push(pair(slot, out));
  if (matching.length === 1) return { kind: 'auto', option: matching[0] };
  if (matching.length > 1) return { kind: 'ask', options: matching };

  const open = free.find((s) => s.def.types.length === 0) ?? free.find((s) => outputs.some((o) => o.types.length === 0));
  if (!open) return { kind: 'none' };
  const candidates = outputs
    .filter((o) => open.def.types.length === 0 || o.types.length === 0)
    .map((o) => pair(open, o));
  if (candidates.length === 1) return { kind: 'auto', option: candidates[0] };
  return candidates.length > 1 ? { kind: 'ask', options: candidates } : { kind: 'none' };
}

/** The node-data patch that links `slotId` to an output of `sourceId`. */
export function linkPatch(data: any, slotId: string, sourceId: string, outputKey: string): Record<string, unknown> {
  return { slotLinks: { ...slotLinksOf(data), [slotId]: { from: sourceId, output: outputKey } } };
}

/** The patch that stores a typed file name for a slot. */
export function typedPatch(data: any, slotId: string, value: string): Record<string, unknown> {
  return { slotFiles: { ...slotFilesOf(data), [slotId]: value } };
}

/** The patch that sets a hand-written slot to read or to write a file. */
export function kindPatch(data: any, slotId: string, kind: SlotKind): Record<string, unknown> {
  return { slotKinds: { ...slotKindsOf(data), [slotId]: kind } };
}

/**
 * The patch that turns a link into a typed file name: the field starts with
 * the files the slot has now, so nothing is lost by unlinking.
 */
export function unlinkPatch(
  node: GraphNodeLike,
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>,
  slotId: string,
  catalog: Catalog = CATALOG
): Record<string, unknown> {
  const state = slotStates(node, nodes, edges, catalog).find((s) => s.def.id === slotId);
  const links = { ...slotLinksOf(node.data) };
  delete links[slotId];
  const typed = state?.link ? state.files.join(', ') : slotFilesOf(node.data)[slotId] ?? '';
  return { slotLinks: links, slotFiles: { ...slotFilesOf(node.data), [slotId]: typed } };
}

/**
 * A new connection `sourceId` -> `targetId`: forgets the links of the later
 * step whose connection no longer exists (so a removed connection that is drawn
 * again does not bring back an old file), then binds as `planBinding` says.
 * `edgesBefore` is the canvas without the new connection. Returns the nodes to
 * show and the plan, which is `ask` when the person has to choose.
 */
export function connectWithBinding<N extends GraphNodeLike>(
  nodes: ReadonlyArray<N>,
  edgesBefore: ReadonlyArray<GraphEdgeLike>,
  edgesAfter: ReadonlyArray<GraphEdgeLike>,
  sourceId: string,
  targetId: string,
  catalog: Catalog = CATALOG
): { nodes: N[]; plan: BindingPlan } {
  let next = [...nodes];
  const target = next.find((n) => n.id === targetId);
  if (!target) return { nodes: next, plan: { kind: 'none' } };

  const links = slotLinksOf(target.data);
  const kept: Record<string, SlotLink> = {};
  for (const [id, link] of Object.entries(links)) {
    if (edgesBefore.some((e) => e.source === link.from && e.target === targetId)) kept[id] = link;
  }
  if (Object.keys(kept).length !== Object.keys(links).length) {
    next = next.map((n) => (n.id === targetId ? { ...n, data: { ...n.data, slotLinks: kept } } : n));
  }

  const plan = planBinding(next, edgesAfter, sourceId, targetId, catalog);
  if (plan.kind === 'auto') next = applyBinding(next, targetId, sourceId, plan.option);
  return { nodes: next, plan };
}

/** The nodes with `option` applied to the later step. */
export function applyBinding<N extends GraphNodeLike>(
  nodes: ReadonlyArray<N>,
  targetId: string,
  sourceId: string,
  option: BindingOption
): N[] {
  return nodes.map((n) =>
    n.id === targetId
      ? { ...n, data: { ...n.data, ...linkPatch(n.data, option.slot, sourceId, option.outputKey) } }
      : n
  );
}

export interface LinkChoice {
  /** `<node id>|<output key>`, the value of the select. */
  value: string;
  nodeId: string;
  outputKey: string;
  /** "Trim reads: Output file (trimmed.fastq)". */
  label: string;
}

/**
 * The outputs a slot can be linked to by hand: those of the steps that run
 * before this one (the ticked "Runs after" steps). The keyboard's way to do
 * what a connection does automatically.
 */
export function linkChoices(
  node: GraphNodeLike,
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>,
  catalog: Catalog = CATALOG
): LinkChoice[] {
  const choices: LinkChoice[] = [];
  for (const edge of edges) {
    if (edge.target !== node.id) continue;
    const source = nodes.find((n) => n.id === edge.source);
    if (!source) continue;
    for (const item of outputItems(source, catalog)) {
      const file = item.files.length === 1 ? item.files[0] : `${item.files.length} files`;
      choices.push({
        value: `${source.id}|${item.key}`,
        nodeId: source.id,
        outputKey: item.key,
        label: `${stepLabelOf(source)}: ${item.label} (${file})`,
      });
    }
  }
  return choices;
}

// -----------------------------------------------------------------------------
// Engine YAML
// -----------------------------------------------------------------------------

/**
 * The `named_inputs` and `named_outputs` of a step for the engine, or nothing
 * for a step without slots (so plain steps keep their old YAML). A slot with
 * no file is written with an empty list: the engine then names it in its error
 * instead of passing a literal `{ref}` to the shell.
 */
export function slotYaml(
  node: GraphNodeLike,
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>,
  catalog: Catalog = CATALOG
): { named_inputs?: Record<string, string[]>; named_outputs?: Record<string, string[]> } {
  const states = slotStates(node, nodes, edges, catalog);
  const named_inputs: Record<string, string[]> = {};
  const named_outputs: Record<string, string[]> = {};
  for (const s of states) (s.def.kind === 'input' ? named_inputs : named_outputs)[s.def.id] = s.files;
  const out: { named_inputs?: Record<string, string[]>; named_outputs?: Record<string, string[]> } = {};
  if (Object.keys(named_inputs).length > 0) out.named_inputs = named_inputs;
  if (Object.keys(named_outputs).length > 0) out.named_outputs = named_outputs;
  return out;
}

// -----------------------------------------------------------------------------
// Resolved command preview
// -----------------------------------------------------------------------------

export type PreviewState = 'text' | 'filled' | 'missing';

export interface PreviewPiece {
  text: string;
  state: PreviewState;
  /** The placeholder name, for `filled` and `missing` pieces. */
  name?: string;
  /** Why a `missing` piece could not be filled. */
  reason?: 'no-file' | 'unknown' | 'unsafe';
}

export interface Preview {
  pieces: PreviewPiece[];
  /** The command with everything resolved, missing placeholders left as written. */
  text: string;
  /** Placeholders that could not be filled, without repeats. */
  missing: string[];
}

export interface PreviewContext {
  /** The step has slots: every placeholder must resolve. Otherwise only the built-ins are filled. */
  structured: boolean;
  input: string[];
  output: string[];
  threads: number;
  /** Files of each slot; an empty list is a slot with no file yet. */
  slots: Record<string, string[]>;
}

const escapeDouble = (file: string) => file.replace(/[\\"$`]/g, '\\$&');

function fillFiles(files: string[], quote: Quote): string {
  switch (quote) {
    case 'single':
      return files.map((f) => f.replace(/'/g, `'\\''`)).join(' ');
    case 'double':
      return files.map(escapeDouble).join(' ');
    default:
      return files.map(shellQuote).join(' ');
  }
}

/**
 * The command as it will run, with each placeholder replaced by its files.
 * Placeholders with no file stay as written and are listed as `missing`, so the
 * panel can mark them. File names are quoted the way the engine quotes them
 * (the preview leaves the quotes off names that need none).
 */
export function previewCommand(command: string, ctx: PreviewContext): Preview {
  const pieces: PreviewPiece[] = [];
  const missing: string[] = [];
  const addMissing = (name: string) => {
    if (!missing.includes(name)) missing.push(name);
  };
  const addText = (text: string) => {
    if (!text) return;
    const last = pieces[pieces.length - 1];
    if (last && last.state === 'text') last.text += text;
    else pieces.push({ text, state: 'text' });
  };

  const builtin = (name: string): string[] | undefined => {
    switch (name) {
      case 'input':
      case 'inputs':
        return ctx.input;
      case 'output':
      case 'outputs':
        return ctx.output;
      default:
        return undefined;
    }
  };

  const parts: CommandPart[] = ctx.structured
    ? scanCommand(command)
    : splitBuiltins(command);

  for (const part of parts) {
    if (part.kind === 'text') {
      addText(part.text);
      continue;
    }
    const { name, quote, problem } = part;
    if (name === 'threads') {
      pieces.push({ text: String(ctx.threads), state: 'filled', name });
      continue;
    }
    const files = builtin(name) ?? (ctx.structured ? ctx.slots[name] : undefined);
    if (files === undefined) {
      // Unknown: in a step with slots the engine rejects it; in a plain one it is just text.
      if (ctx.structured) {
        pieces.push({ text: `{${name}}`, state: 'missing', name, reason: 'unknown' });
        addMissing(name);
      } else {
        addText(`{${name}}`);
      }
    } else if (files.length === 0 || files.some((f) => f.trim() === '')) {
      pieces.push({ text: `{${name}}`, state: 'missing', name, reason: 'no-file' });
      addMissing(name);
    } else if (problem) {
      pieces.push({ text: `{${name}}`, state: 'missing', name, reason: 'unsafe' });
      addMissing(name);
    } else {
      pieces.push({ text: fillFiles(files, quote), state: 'filled', name });
    }
  }
  return { pieces, missing, text: pieces.map((p) => p.text).join('') };
}

/** A plain step: only the engine's own placeholders are placeholders. */
function splitBuiltins(command: string): CommandPart[] {
  const parts: CommandPart[] = [];
  let last = 0;
  for (const match of command.matchAll(/\{(inputs?|outputs?|threads)\}/g)) {
    if (match.index! > last) parts.push({ kind: 'text', text: command.slice(last, match.index) });
    parts.push({ kind: 'hole', name: match[1], quote: 'none' });
    last = match.index! + match[0].length;
  }
  if (last < command.length) parts.push({ kind: 'text', text: command.slice(last) });
  return parts;
}

/** The preview of a node on the canvas, with its slots resolved through the connections. */
export function previewForNode(
  node: GraphNodeLike,
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>,
  catalog: Catalog = CATALOG
): Preview {
  const data = node.data ?? {};
  const states = slotStates(node, nodes, edges, catalog);
  const slots: Record<string, string[]> = {};
  for (const s of states) slots[s.def.id] = s.files;
  const threads = Math.max(1, Math.floor(Number(data.threads)) || 1);
  return previewCommand(typeof data.command === 'string' ? data.command : '', {
    structured: states.length > 0,
    input: declaredOutputs(data.input),
    output: declaredOutputs(data.output),
    threads,
    slots,
  });
}

// -----------------------------------------------------------------------------
// Problems
// -----------------------------------------------------------------------------

export interface SlotIssue {
  /** The slot, for the field the message belongs to. */
  slot: string;
  kind: 'missing' | 'name';
  message: string;
}

/**
 * What stops a run because of the slots: a slot with no file (a link whose
 * source has no output yet is said so), a name the engine would refuse.
 */
export function slotIssues(
  node: GraphNodeLike,
  nodes: ReadonlyArray<GraphNodeLike>,
  edges: ReadonlyArray<GraphEdgeLike>,
  catalog: Catalog = CATALOG
): SlotIssue[] {
  const issues: SlotIssue[] = [];
  for (const state of slotStates(node, nodes, edges, catalog)) {
    const { def } = state;
    if (def.id.length > MAX_SLOT_NAME_LENGTH) {
      issues.push({
        slot: def.id,
        kind: 'name',
        message: `The placeholder {${def.id}} is longer than ${MAX_SLOT_NAME_LENGTH} characters. Shorten it in the command.`,
      });
    }
    if (state.files.length > 0) continue;
    issues.push({
      slot: def.id,
      kind: 'missing',
      message: state.link
        ? `"${def.label}" comes from ${state.link.stepLabel}, which has no ${state.link.outputLabel.toLowerCase()} yet. Set it there or choose a file here.`
        : def.kind === 'input'
          ? `Choose a file for "${def.label}" (written {${def.id}} in the command).`
          : `Say where "${def.label}" is written (written {${def.id}} in the command).`,
    });
  }
  return issues;
}

/** The files a patch-free read of a node's output slots gives, for check targets. */
export function namedOutputFiles(node: GraphNodeLike, catalog: Catalog = CATALOG): string[] {
  return outputItems(node, catalog)
    .filter((o) => o.key !== '')
    .flatMap((o) => o.files);
}
