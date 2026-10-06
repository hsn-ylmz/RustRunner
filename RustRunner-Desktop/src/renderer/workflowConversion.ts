/**
 * Pure workflow logic: canvas -> engine workflow conversion, validation and
 * wildcard helpers. No React or Electron imports so it is unit-testable.
 */

export function labelToId(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/** The wildcard name the file picker generates patterns for. */
export const WILDCARD_NAME = 'sample';

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
  nodeWildcardFiles: Record<string, string[]> = {}
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

    const step: any = {
      id: stepId,
      tool: node.data.tool || '',
      command: node.data.command || '',
      input: node.data.input ? [node.data.input] : [],
      output: node.data.output ? [node.data.output] : [],
      previous: incoming.map((e: any) => nodeIdToStepId.get(e.source)!),
      next: outgoing.map((e: any) => nodeIdToStepId.get(e.target)!),
      threads: normalizeThreads(node.data.threads),
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

    // Output checks mirror the Rust `checks` list; omitted when none apply.
    const checks = buildChecks(node.data);
    if (checks.length > 0) {
      step.checks = checks;
    }

    // Omit the key entirely when empty — Rust skips serializing empty maps and
    // an empty mapping would just be noise in the YAML.
    if (files.length > 0) {
      step.wildcard_files = { [WILDCARD_NAME]: files };
    }

    return step;
  });

  return { steps };
}

/** Coerces a threads value from the UI into a positive integer. */
export function normalizeThreads(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
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
  blocking?: false;
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
 * Checks need an output to look at, so a step without one emits none (the
 * Rust validator would reject them). `blocking` is only written when off,
 * because true is the engine default.
 */
export function buildChecks(data: any): OutputCheckYaml[] {
  if (!data?.output) return [];
  const checks: OutputCheckYaml[] = [];
  if (isOn(data.checkExists)) checks.push({ kind: 'exists' });
  if (isOn(data.checkNonEmpty)) checks.push({ kind: 'non_empty' });
  if (isOn(data.checkMinLinesEnabled)) {
    // An enabled preset with an unusable N would be rejected by the engine
    // (min_lines 0 can never fail), so it is dropped instead.
    const lines = normalizeMinLines(data.checkMinLines);
    if (lines !== undefined) checks.push({ kind: 'min_lines', lines });
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
  });

  return errors;
}

/**
 * Generates a wildcard pattern from a list of files.
 * Example: ["sample1.fastq", "sample2.fastq"] -> "{sample}.fastq"
 */
export function generatePattern(files: string[]): string {
  if (files.length === 0) return '';
  
  const firstFile = files[0];
  const fileName = firstFile.split('/').pop() || firstFile;
  const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
  const dir = firstFile.substring(0, firstFile.lastIndexOf('/') + 1);
  
  return `${dir}{sample}${ext}`;
}

/**
 * Checks if a string contains wildcard syntax.
 */
export function hasWildcards(text: string): boolean {
  return text.includes('{') && text.includes('}');
}
