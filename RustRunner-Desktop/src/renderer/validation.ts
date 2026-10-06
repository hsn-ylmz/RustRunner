/**
 * What stops a workflow from running, as a list of problems a person can act
 * on. Each problem names the step by the label the person gave it, says what
 * is wrong, and points at the field to fix, so the UI can show it next to the
 * field, list it in one summary and jump to it on click.
 *
 * This checks the canvas nodes. `validateWorkflow` (workflowConversion.ts) still
 * checks the converted workflow right before a run as a backstop; the tests
 * keep the two in agreement.
 */

import {
  declaredOutputs,
  extractWildcardNames,
  findInvalidNodeIds,
  normalizeCheckTarget,
  normalizeWildcardName,
} from './workflowConversion';
import { findTool, missingRequiredParams } from './tools/catalog';

/**
 * The control a problem belongs to. Plain node fields use the field's own name;
 * a catalog option is `param:<id>`; a check aimed at one output uses the node
 * field that holds its target.
 */
export type IssueField =
  | 'label'
  | 'tool'
  | 'command'
  | 'input'
  | 'output'
  | 'checkExistsTarget'
  | 'checkNonEmptyTarget'
  | 'checkMinLinesTarget'
  | `param:${string}`;

export interface ValidationIssue {
  /** Stable for a given problem: node, field and kind. */
  id: string;
  /** Absent for a problem with the workflow as a whole. */
  nodeId?: string;
  nodeLabel?: string;
  field?: IssueField;
  /** What is wrong and what to do, without the step's name. */
  message: string;
}

const isOn = (value: unknown) => value === true || value === 'true';

/** A node's name for messages: what the person typed, or a stand-in when empty. */
function displayName(node: any): string {
  const label = typeof node.data?.label === 'string' ? node.data.label.trim() : '';
  return label || 'Unnamed step';
}

const CHECKS: { flag: string; target: IssueField; name: string }[] = [
  { flag: 'checkExists', target: 'checkExistsTarget', name: 'exists' },
  { flag: 'checkNonEmpty', target: 'checkNonEmptyTarget', name: 'non-empty' },
  { flag: 'checkMinLinesEnabled', target: 'checkMinLinesTarget', name: 'line-count' },
];

/** Every problem that would stop a run, in canvas order. Empty when the workflow can run. */
export function collectIssues(
  nodes: any[],
  wildcardFiles: Record<string, string[]> = {}
): ValidationIssue[] {
  if (nodes.length === 0) {
    return [{ id: 'workflow:empty', message: 'The workflow has no steps. Add a step to begin.' }];
  }

  const issues: ValidationIssue[] = [];
  const invalidNames = findInvalidNodeIds(nodes);

  for (const node of nodes) {
    const data = node.data ?? {};
    const nodeLabel = displayName(node);
    const add = (field: IssueField | undefined, kind: string, message: string) =>
      issues.push({
        id: `${node.id}:${field ?? 'node'}:${kind}`,
        nodeId: node.id,
        nodeLabel,
        field,
        message,
      });

    if (invalidNames[node.id]) {
      add(
        'label',
        'name',
        invalidNames[node.id].startsWith('Duplicate')
          ? 'Another step has the same name. Give each step its own name.'
          : 'Give the step a name with at least one letter or number.'
      );
    }

    const catalogTool = findTool(data.catalogId);
    const hand = data.catalogCommandCustom === true;

    if (!String(data.tool ?? '').trim()) {
      add('tool', 'missing', 'Enter the tool this step uses, for example bash or fastqc.');
    }

    // A catalog step's command is built from its options, so a gap there is
    // reported on the option instead of as an empty command.
    if (catalogTool && !hand) {
      for (const id of missingRequiredParams(catalogTool, data.catalogParams)) {
        const label = catalogTool.params.find((p) => p.id === id)?.label ?? id;
        add(`param:${id}`, 'missing', `Fill in "${label}".`);
      }
    } else if (!String(data.command ?? '').trim()) {
      add('command', 'missing', 'Enter the command this step runs.');
    }

    // A check aimed at one output must name an output the step still has.
    const outputs = declaredOutputs(data.output);
    if (data.output) {
      for (const check of CHECKS) {
        const target = normalizeCheckTarget(data[check.target]);
        if (isOn(data[check.flag]) && target !== undefined && !outputs.includes(target)) {
          add(
            check.target,
            'stale',
            `The ${check.name} check points at "${target}", which is not one of this step's outputs. Pick another output or "All outputs".`
          );
        }
      }
    }

    // Every {name} in a path pattern needs files to fill it in.
    const mapped =
      (wildcardFiles[node.id] ?? []).length > 0 ? [normalizeWildcardName(data.wildcardName)] : [];
    for (const field of ['input', 'output'] as const) {
      for (const name of extractWildcardNames(String(data[field] ?? ''))) {
        if (mapped.includes(name)) continue;
        add(
          field,
          `wildcard-${name}`,
          mapped.length > 0
            ? `The pattern uses {${name}} but the selected files are for {${mapped[0]}}.`
            : `The pattern uses {${name}} but no files are selected. Select files for batch processing, or remove {${name}}.`
        );
      }
    }
  }

  return issues;
}

/** "Fix 2 problems first: Align: Enter the command this step runs." */
export function blockedReason(issues: ValidationIssue[]): string | undefined {
  if (issues.length === 0) return undefined;
  const first = issues[0];
  const where = first.nodeLabel ? `${first.nodeLabel}: ` : '';
  const count = issues.length === 1 ? '1 problem' : `${issues.length} problems`;
  return `Fix ${count} before running. First: ${where}${first.message}`;
}

/** The problems that belong to one field of one node, keyed by field. */
export function fieldErrors(
  issues: ValidationIssue[],
  nodeId: string
): Partial<Record<IssueField, string>> {
  const out: Partial<Record<IssueField, string>> = {};
  for (const issue of issues) {
    if (issue.nodeId === nodeId && issue.field && !(issue.field in out)) {
      out[issue.field] = issue.message;
    }
  }
  return out;
}

/** A short title for the summary: "3 problems" / "1 problem". */
export function issueCountLabel(count: number): string {
  return count === 1 ? '1 problem' : `${count} problems`;
}
