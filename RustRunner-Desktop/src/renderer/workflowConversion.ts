/**
 * Pure workflow logic: canvas -> engine workflow conversion, validation and
 * wildcard helpers. No React or Electron imports so it is unit-testable.
 */

import {
  DEFAULT_WILDCARD_NAME,
  MAX_WILDCARD_NAME_LENGTH,
  declaredOutputs,
  extractWildcardNames,
  labelToId,
  normalizeThreads,
  normalizeWildcardName,
  wildcardNameError,
} from './stepNames';
import { slotYaml, unescapeBraces } from './slots';

// Re-exported: these live in stepNames.ts so the tool catalog can use them
// without importing this module (which imports the catalog through slots).
export {
  DEFAULT_WILDCARD_NAME,
  MAX_WILDCARD_NAME_LENGTH,
  declaredOutputs,
  extractWildcardNames,
  labelToId,
  normalizeThreads,
  normalizeWildcardName,
  wildcardNameError,
};

/** Replaces `{from}` with `{to}` in a path pattern. */
export function renameWildcardInPattern(text: string, from: string, to: string): string {
  if (!text || from === to) return text;
  return text.split(`{${from}}`).join(`{${to}}`);
}

/**
 * Builds the engine-facing workflow from the canvas.
 *
 * Wildcard files are attached **per step** as `wildcard_files`, matching the
 * Rust `Step` struct. `load_workflow` merges those and expands the workflow
 * before validation, so no CLI flag is involved — the engine has no
 * `--wildcards` option and rejects unknown ones outright.
 *
 * Files are looked up from the live `nodes` list rather than iterated out of
 * `nodeWildcardFiles`, so entries left behind by deleted nodes can never reach
 * a run, and each step gets only its own files instead of the union of all.
 */
export function convertNodesToWorkflow(
  nodes: any[],
  edges: any[],
  nodeWildcardFiles: Record<string, string[]> = {},
  details: WorkflowDetails = {}
) {
  const nodeIdToStepId = new Map<string, string>();
  nodes.forEach((node: any) => {
    nodeIdToStepId.set(node.id, labelToId(node.data.label));
  });

  const steps = nodes.map((node: any) => {
    const stepId = nodeIdToStepId.get(node.id)!;
    const incoming = edges.filter((e: any) => e.target === node.id);
    const outgoing = edges.filter((e: any) => e.source === node.id);
    const files = nodeWildcardFiles[node.id] || [];
    // Named file slots (see slots.ts). Only a step that has some gets the
    // strict placeholder rules in the engine, so plain steps are written as before.
    const slotInfo = slotYaml(node, nodes, edges);
    const hasSlots = Object.keys(slotInfo).length > 0;

    const step: any = {
      id: stepId,
      tool: node.data.tool || '',
      // `{{x}}` keeps literal braces in a step with slots; a step without them
      // gets the braces the way the engine would pass them to the shell.
      command: hasSlots ? node.data.command || '' : unescapeBraces(node.data.command || ''),
      input: node.data.input ? [node.data.input] : [],
      output: node.data.output ? [node.data.output] : [],
      previous: incoming.map((e: any) => nodeIdToStepId.get(e.source)!),
      next: outgoing.map((e: any) => nodeIdToStepId.get(e.target)!),
      threads: normalizeThreads(node.data.threads),
      ...slotInfo,
    };

    // Retry / timeout settings are emitted only when they change behaviour so
    // YAML for plain steps stays exactly as it was. Keys are snake_case: they
    // go straight into the YAML the Rust `Step` struct deserializes.
    const retries = normalizeRetries(node.data.retries);
    if (retries > 0) {
      step.retries = retries;
      step.retry_backoff = normalizeBackoff(node.data.retryBackoff);
      step.retry_delay_secs = normalizeRetryDelay(node.data.retryDelaySecs);
    }
    const timeoutSecs = normalizeTimeout(node.data.timeoutSecs);
    if (timeoutSecs !== undefined) {
      step.timeout_secs = timeoutSecs;
    }

    // A mocked step makes placeholder outputs instead of running its tool.
    // Written only when on, because false is the engine default.
    if (isOn(node.data.mock)) {
      step.mock = true;
    }

    // Output checks mirror the Rust `checks` list; omitted when none apply.
    const checks = buildChecks(node.data, Object.keys(slotInfo.named_outputs ?? {}).length > 0);
    if (checks.length > 0) {
      step.checks = checks;
    }

    // Omit the key entirely when empty — Rust skips serializing empty maps and
    // an empty mapping would just be noise in the YAML.
    if (files.length > 0) {
      step.wildcard_files = { [normalizeWildcardName(node.data.wildcardName)]: files };
    }

    return step;
  });

  // Optional top-level settings come first and only appear when they change
  // behaviour, so plain workflows keep their old YAML.
  const workflow: any = {};
  const metadata = buildMetadata(details);
  if (metadata) workflow.metadata = metadata;
  if (details.keepGoing === true) workflow.keep_going = true;
  workflow.steps = steps;
  return workflow;
}

/** Longest name/version the engine accepts (`MAX_METADATA_LEN` in model.rs). */
export const MAX_METADATA_LEN = 200;

/** Longest id the engine accepts (`MAX_ID_LEN` in model.rs). */
export const MAX_WORKFLOW_ID_LEN = 64;

/**
 * True when `value` can be a workflow id: what the engine accepts, since the id
 * names the saved-run file (letters, digits, `-` and `_` only; no path parts).
 */
export function isValidWorkflowId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_WORKFLOW_ID_LEN &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/** A new random id for a workflow (a UUID). */
export function generateWorkflowId(): string {
  const c: Crypto | undefined = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback for environments without randomUUID: 128 random bits as hex.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The name, version, stable id and run settings of a workflow. */
export interface WorkflowDetails {
  /** Stable id; keys the engine's saved run so renaming keeps its history. */
  id?: string;
  name?: string;
  version?: string;
  /** Keep running independent steps after one fails. */
  keepGoing?: boolean;
}

/** Trims, drops control characters (the engine rejects them) and caps the length. */
export function normalizeMetadataText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, MAX_METADATA_LEN).trim();
}

/**
 * The engine's optional `metadata` block, or undefined when neither a name nor
 * a version is set so plain workflows keep their old YAML.
 */
export function buildMetadata(
  details: WorkflowDetails
): { id?: string; name?: string; version?: string } | undefined {
  const id = isValidWorkflowId(details.id) ? details.id : '';
  const name = normalizeMetadataText(details.name);
  const version = normalizeMetadataText(details.version);
  if (!id && !name && !version) return undefined;
  const metadata: { id?: string; name?: string; version?: string } = {};
  if (id) metadata.id = id;
  if (name) metadata.name = name;
  if (version) metadata.version = version;
  return metadata;
}

/** Limits mirrored from the Rust validator (`MAX_RETRIES`, `MAX_RETRY_DELAY_SECS`). */
export const MAX_RETRIES = 100;
export const MAX_RETRY_DELAY_SECS = 3600;
export const DEFAULT_RETRY_DELAY_SECS = 5;

export type RetryBackoff = 'fixed' | 'exponential';

/** Coerces a retries value into an integer in [0, MAX_RETRIES]. */
export function normalizeRetries(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_RETRIES);
}

/** Anything other than 'exponential' means a fixed delay. */
export function normalizeBackoff(value: unknown): RetryBackoff {
  return value === 'exponential' ? 'exponential' : 'fixed';
}

/** Coerces the base retry delay into an integer in [0, MAX_RETRY_DELAY_SECS]. */
export function normalizeRetryDelay(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_RETRY_DELAY_SECS;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETRY_DELAY_SECS;
  return Math.min(n, MAX_RETRY_DELAY_SECS);
}

/** An output check as the Rust `OutputCheck` deserializes it. */
export interface OutputCheckYaml {
  kind: 'exists' | 'non_empty' | 'min_lines';
  lines?: number;
  /** One declared output, spelled as in the step's `output`; absent = all outputs. */
  target?: string;
  blocking?: false;
}

/** A check target from the UI: a non-blank string, or undefined for "all outputs". */
export function normalizeCheckTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const target = value.trim();
  return target === '' ? undefined : target;
}

/** How many canvas nodes are mocked (for the run toolbar's warning). */
export function countMockedNodes(nodes: any[]): number {
  return nodes.filter((node: any) => isOn(node?.data?.mock)).length;
}

/** A positive whole number of lines, or undefined when not usable. */
export function normalizeMinLines(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

/** Checkbox state is stored as a boolean, but tolerate 'true' from old/loose data. */
function isOn(value: unknown): boolean {
  return value === true || value === 'true';
}

/** The "Blocking" toggle defaults to on; only an explicit off disables it. */
export function isBlocking(value: unknown): boolean {
  return !(value === false || value === 'false');
}

/**
 * Turns the Properties panel's check presets into the engine's `checks` list.
 * Checks need an output to look at (the main one or a named one), so a step
 * without any emits none (the Rust validator would reject them). `blocking` is only written when off,
 * because true is the engine default.
 */
export function buildChecks(data: any, hasNamedOutputs = false): OutputCheckYaml[] {
  if (!data?.output && !hasNamedOutputs) return [];
  const checks: OutputCheckYaml[] = [];
  const withTarget = (check: OutputCheckYaml, target: unknown): OutputCheckYaml => {
    const t = normalizeCheckTarget(target);
    if (t !== undefined) check.target = t;
    return check;
  };
  if (isOn(data.checkExists)) {
    checks.push(withTarget({ kind: 'exists' }, data.checkExistsTarget));
  }
  if (isOn(data.checkNonEmpty)) {
    checks.push(withTarget({ kind: 'non_empty' }, data.checkNonEmptyTarget));
  }
  if (isOn(data.checkMinLinesEnabled)) {
    // An enabled preset with an unusable N would be rejected by the engine
    // (min_lines 0 can never fail), so it is dropped instead.
    const lines = normalizeMinLines(data.checkMinLines);
    if (lines !== undefined) {
      checks.push(withTarget({ kind: 'min_lines', lines }, data.checkMinLinesTarget));
    }
  }
  if (!isBlocking(data.checkBlocking)) {
    checks.forEach((c) => {
      c.blocking = false;
    });
  }
  return checks;
}

/** A positive whole number of seconds, or undefined for "no timeout". */
export function normalizeTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

/**
 * Finds step ids that would collide or be empty once labels are slugified.
 * Surfaced live on the canvas rather than only when Run is pressed, since
 * `labelToId` silently maps "Process" and "process" onto the same id.
 */
export function findInvalidNodeIds(nodes: any[]): Record<string, string> {
  const counts = new Map<string, number>();
  nodes.forEach((node: any) => {
    const id = labelToId(node.data?.label || '');
    counts.set(id, (counts.get(id) || 0) + 1);
  });

  const problems: Record<string, string> = {};
  nodes.forEach((node: any) => {
    const id = labelToId(node.data?.label || '');
    if (!id) {
      problems[node.id] = 'Name must contain at least one letter or number';
    } else if ((counts.get(id) || 0) > 1) {
      problems[node.id] = `Duplicate step ID "${id}"`;
    }
  });

  return problems;
}

export function validateWorkflow(workflow: any): string[] {
  const errors: string[] = [];

  if (!workflow.steps || workflow.steps.length === 0) {
    errors.push('Workflow has no steps');
    return errors;
  }

  const stepIds = new Set<string>();
  workflow.steps.forEach((step: any) => {
    if (stepIds.has(step.id)) {
      errors.push(`Duplicate step ID: ${step.id}`);
    }
    stepIds.add(step.id);

    if (!step.id || step.id.trim() === '') {
      errors.push('Step has empty ID');
    }
    if (!step.tool || step.tool.trim() === '') {
      errors.push(`Step ${step.id}: missing tool`);
    }
    if (!step.command || step.command.trim() === '') {
      errors.push(`Step ${step.id}: missing command`);
    }

    // A check aimed at one output must name an output the step still has (the
    // engine rejects it otherwise); say so before the run starts.
    // A target may be a path or the name of a named output.
    const namedOutputs: Record<string, string[]> = step.named_outputs ?? {};
    const outputs = [
      ...(step.output ?? []).flatMap((o: string) => declaredOutputs(o)),
      ...Object.values(namedOutputs).flat(),
      ...Object.keys(namedOutputs),
    ];
    for (const check of step.checks ?? []) {
      if (check.target !== undefined && !outputs.includes(check.target)) {
        errors.push(
          `Step ${step.id}: the ${check.kind} check targets "${check.target}", which is not one of the step's outputs`
        );
      }
    }

    // Every {name} in a path pattern needs files; the engine would reject the
    // step otherwise, and this says so before the run starts.
    const mapped = Object.keys(step.wildcard_files ?? {});
    const slotFiles: string[] = [
      ...Object.values((step.named_inputs ?? {}) as Record<string, string[]>).flat(),
      ...Object.values(namedOutputs).flat(),
    ];
    const used = extractWildcardNames(
      [...(step.input ?? []), ...(step.output ?? []), ...slotFiles].join(' ')
    );
    for (const name of used) {
      if (!mapped.includes(name)) {
        errors.push(
          mapped.length > 0
            ? `Step ${step.id}: pattern uses {${name}} but the selected files are for {${mapped[0]}}`
            : `Step ${step.id}: pattern uses {${name}} but no files are selected for it`
        );
      }
    }

    // A slot with no file would reach the engine as an unbound placeholder.
    for (const [slot, files] of [
      ...Object.entries((step.named_inputs ?? {}) as Record<string, string[]>),
      ...Object.entries(namedOutputs),
    ]) {
      if (files.length === 0) {
        errors.push(`Step ${step.id}: "${slot}" has no file yet`);
      }
    }
  });

  return errors;
}

/**
 * Generates a wildcard pattern from a list of files.
 * Example: ["sample1.fastq", "sample2.fastq"] -> "{sample}.fastq"
 */
export function generatePattern(
  files: string[],
  wildcardName: string = DEFAULT_WILDCARD_NAME
): string {
  if (files.length === 0) return '';
  
  const firstFile = files[0];
  const fileName = firstFile.split('/').pop() || firstFile;
  const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
  const dir = firstFile.substring(0, firstFile.lastIndexOf('/') + 1);
  
  return `${dir}{${wildcardName}}${ext}`;
}

/**
 * Checks if a string contains wildcard syntax.
 */
export function hasWildcards(text: string): boolean {
  return text.includes('{') && text.includes('}');
}
