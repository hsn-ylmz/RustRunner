/**
 * Turning a template into steps on the canvas.
 *
 * This is the one code path for "New from template": the gallery's setup step,
 * the tests and the real-tool suite all call `instantiateTemplate`. Each step
 * is made the way the tool catalog makes a node (`buildCatalogNodeData`), the
 * connections are drawn with the same ids a drag would give, the files that
 * flow between steps are linked with `linkPatch` (what connecting two steps
 * does), and the person's files go into the template inputs' slots.
 *
 * Pure: no React, no Electron.
 */

import {
  CATALOG,
  buildCatalogNodeData,
  defaultParams,
  findTool,
  renderCommand,
  type Catalog,
} from '../tools/catalog';
import { edgeIdFor } from '../connections';
import { extensionsOfType, linkPatch, typesOfPath } from '../slots';
import { parseTemplate, stepLabels, type TemplateInput, type WorkflowTemplate } from './schema';

/** What the person gave for each input: a list of file paths per input id. */
export type InputValues = Record<string, string[]>;

export interface InstantiateOptions {
  catalog?: Catalog;
  /** Where the top-left step goes on the canvas. */
  origin?: { x: number; y: number };
  /** Options every new connection carries (the canvas's edge type and animation). */
  edgeDefaults?: Record<string, unknown>;
}

export interface InstantiatedWorkflow {
  ok: true;
  /** The workflow's name: the template's. */
  name: string;
  nodes: any[];
  edges: any[];
  /** Required inputs still without a file: the steps that need them show what is missing. */
  missing: TemplateInput[];
}

export type InstantiateResult = InstantiatedWorkflow | { ok: false; errors: string[] };

/** The id of the canvas node made from a template step. */
export const templateNodeId = (key: string) => `tpl_${key}`;

/** The canvas spot where the first step of a template goes. */
export const DEFAULT_ORIGIN = { x: 80, y: 60 };

/** A path with a comma would be read as two files by the step fields. */
export const COMMA_PROBLEM = 'A file name cannot contain a comma. Rename the file, or move it to a folder without one.';

/** What is wrong with the files given for each input, keyed by input id. A sound input has no entry. */
export function inputProblems(template: WorkflowTemplate, values: InputValues): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const input of template.inputs) {
    const files = (values[input.id] ?? []).map((f) => f.trim()).filter(Boolean);
    if (files.length > 1 && !input.multiple) {
      problems[input.id] = `${input.label} takes one file. Choose a single file.`;
    } else if (files.some((f) => f.includes(','))) {
      problems[input.id] = COMMA_PROBLEM;
    }
  }
  return problems;
}

/**
 * A reminder, not an error: the files whose type does not look like what the
 * input asks for ("reads.bam" for FASTQ). Names with no known extension pass.
 */
export function typeWarning(input: Pick<TemplateInput, 'types' | 'label'>, files: string[]): string | null {
  if (input.types.includes('any')) return null;
  for (const file of files) {
    const found = typesOfPath(file);
    if (found.length > 0 && !found.some((t) => input.types.includes(t))) {
      return `${file.split(/[\\/]/).pop()} looks like a ${found[0].toUpperCase()} file, but ${input.label} should be ${input.types.join(' or ')}. You can still use it.`;
    }
  }
  return null;
}

/** The template's inputs that are required and have no file. */
export function missingInputs(template: WorkflowTemplate, values: InputValues): TemplateInput[] {
  return template.inputs.filter(
    (input) => input.required && (values[input.id] ?? []).every((f) => f.trim() === '')
  );
}

/**
 * The canvas nodes and connections for `template`, with the files in
 * `values` already placed. Inputs left empty leave their slots empty (the
 * validation then says which). Fails with sentences when the template does
 * not fit the tool catalog or the files are unusable.
 */
export function instantiateTemplate(
  template: WorkflowTemplate,
  values: InputValues = {},
  options: InstantiateOptions = {}
): InstantiateResult {
  const catalog = options.catalog ?? CATALOG;
  const parsed = parseTemplate(template, catalog);
  if (parsed.ok === false) return parsed;
  const problems = Object.values(inputProblems(template, values));
  if (problems.length > 0) return { ok: false, errors: problems };

  const origin = options.origin ?? DEFAULT_ORIGIN;
  const labels = stepLabels(template, catalog);
  const minX = Math.min(...template.steps.map((s) => s.position.x));
  const minY = Math.min(...template.steps.map((s) => s.position.y));

  let nodes: any[] = template.steps.map((step) => {
    const tool = findTool(step.tool, catalog)!;
    const data: Record<string, any> = buildCatalogNodeData(tool, [], catalog);
    const params = { ...defaultParams(tool), ...step.params };
    data.label = labels[step.key];
    data.catalogParams = params;
    data.command = renderCommand(tool, params, tool.threads);
    data.slotFiles = { ...data.slotFiles, ...step.files };
    return {
      id: templateNodeId(step.key),
      type: 'custom',
      position: { x: origin.x + step.position.x - minX, y: origin.y + step.position.y - minY },
      data,
    };
  });

  const edges: any[] = [];
  for (const edge of template.edges) {
    const source = templateNodeId(edge.from);
    const target = templateNodeId(edge.to);
    edges.push({ ...options.edgeDefaults, id: edgeIdFor(source, target), source, target });
    for (const bind of edge.bind ?? []) {
      nodes = nodes.map((n) =>
        n.id === target ? { ...n, data: { ...n.data, ...linkPatch(n.data, bind.slot, source, bind.output, catalog) } } : n
      );
    }
  }

  for (const input of template.inputs) {
    const files = (values[input.id] ?? []).map((f) => f.trim()).filter(Boolean);
    if (files.length === 0) continue;
    for (const target of input.targets) {
      nodes = nodes.map((n) =>
        n.id === templateNodeId(target.step)
          ? { ...n, data: { ...n.data, slotFiles: { ...n.data.slotFiles, [target.slot]: files.join(', ') } } }
          : n
      );
    }
  }

  return { ok: true, name: template.name, nodes, edges, missing: missingInputs(template, values) };
}

/** The files in a text field: one for an input that takes one file, comma-separated for several. */
export function filesOf(input: Pick<TemplateInput, 'multiple'>, text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  return input.multiple
    ? trimmed
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : [trimmed];
}

/** The inputs' values for what is typed in the setup step's fields (input id to text). */
export function valuesFromText(template: WorkflowTemplate, texts: Record<string, string>): InputValues {
  const values: InputValues = {};
  for (const input of template.inputs) values[input.id] = filesOf(input, texts[input.id] ?? '');
  return values;
}

/** File name endings the file picker should offer first for an input (`fastq` gives fastq, fq, gz). */
export function pickerExtensions(input: Pick<TemplateInput, 'types'>): string[] {
  if (input.types.includes('any')) return [];
  const names = input.types.flatMap((t) => extensionsOfType(t));
  return names.length > 0 ? [...new Set([...names, 'gz'])] : [];
}
