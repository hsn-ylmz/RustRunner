/**
 * Wording and shape of the run feedback: how a step state reads on the canvas
 * and in the status panel, what the end-of-run summary says, and what the
 * failure card shows. Pure, so it can be unit-tested; the components only draw.
 */

import type { RunSummary, RunStatus } from '../main/engineEvents';
import type { BadgeTone, IconName } from './ui';
import { formatCounts as formatStepCounts, formatDuration } from './runHistoryFormat';
import type { SectionId } from './panelSections';
import { extractStderrTail } from './logLines';
import { resolveBaseStepId, rollupNodeStatuses, type NodeStatus, type StepRuns, type StepState } from './stepEvents';

// -----------------------------------------------------------------------------
// Step states
// -----------------------------------------------------------------------------

/** What a step looks like: a state, or one of its two refinements. */
export type DisplayState = StepState | 'up-to-date' | 'mocked';

export interface StateView {
  key: DisplayState;
  icon: IconName;
  tone: BadgeTone;
  label: string;
}

const STATE_VIEWS: Record<DisplayState, StateView> = {
  pending: { key: 'pending', icon: 'circle', tone: 'neutral', label: 'Waiting' },
  running: { key: 'running', icon: 'dot', tone: 'accent', label: 'Running' },
  retrying: { key: 'retrying', icon: 'retry', tone: 'warning', label: 'Retrying' },
  succeeded: { key: 'succeeded', icon: 'check', tone: 'success', label: 'Done' },
  failed: { key: 'failed', icon: 'x', tone: 'danger', label: 'Failed' },
  skipped: { key: 'skipped', icon: 'skip', tone: 'neutral', label: 'Skipped' },
  'up-to-date': { key: 'up-to-date', icon: 'check', tone: 'neutral', label: 'Up to date' },
  mocked: { key: 'mocked', icon: 'check', tone: 'warning', label: 'Mocked' },
};

/** Icon, tone and label for a state; a skipped step may be up to date, a done one mocked. */
export function stateView(
  state: StepState,
  flags: { upToDate?: boolean; mocked?: boolean } = {}
): StateView {
  if (state === 'skipped' && flags.upToDate) return STATE_VIEWS['up-to-date'];
  if (state === 'succeeded' && flags.mocked) return STATE_VIEWS.mocked;
  return STATE_VIEWS[state];
}

/**
 * The short line shown on a node while and after a run: the state, plus the
 * attempt while retrying and the count when a node expanded into many steps.
 */
export function nodeStatusLine(status: NodeStatus): string {
  const view = stateView(status.state, status);
  if (status.state === 'retrying' && status.attempt && status.maxAttempts) {
    // `attempt` is the one that failed; the next is what the person waits for.
    return `Retrying, attempt ${Math.min(status.attempt + 1, status.maxAttempts)} of ${status.maxAttempts}`;
  }
  if (status.total > 1 && (status.state === 'running' || status.state === 'succeeded')) {
    return `${view.label}, ${status.finished} of ${status.total} files`;
  }
  return view.label;
}

/** Status a node has before the engine reports on it, while a run is active. */
export const PENDING_STATUS: NodeStatus = { state: 'pending', finished: 0, total: 0 };

// -----------------------------------------------------------------------------
// End of run
// -----------------------------------------------------------------------------

export interface RunResult {
  status: RunStatus;
  summary: RunSummary;
  /** Absolute path of the HTML report; absent for a dry run. */
  report?: string;
}

export interface RunSummaryView {
  tone: BadgeTone;
  icon: IconName;
  title: string;
  /** Duration and counts. */
  detail: string;
  /** Extra facts worth a glance: retries, check warnings, mocked steps. */
  notes: string[];
  /** Why the run did not succeed, in the engine's words. */
  error?: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Title, tone and one-line detail for the end-of-run banner. */
export function describeRunResult(result: RunResult, dryRun = false): RunSummaryView {
  const { summary } = result;
  const duration = formatDuration(summary.duration_secs);
  const counts = `${formatStepCounts(summary)} ${summary.total === 1 ? 'step' : 'steps'}`;
  const detail = [duration, counts].filter(Boolean).join(', ');

  const notes: string[] = [];
  if (summary.retried > 0) notes.push(`${plural(summary.retried, 'step', 'steps')} needed a retry`);
  if (summary.check_warnings > 0) {
    notes.push(plural(summary.check_warnings, 'check warning', 'check warnings'));
  }
  if (summary.mocked) notes.push(`${plural(summary.mocked, 'step', 'steps')} mocked, tools not run`);

  const prefix = dryRun ? 'Dry run' : 'Run';
  const error = summary.error?.trim() || undefined;
  switch (result.status) {
    case 'succeeded':
      return { tone: 'success', icon: 'check', title: `${prefix} succeeded`, detail, notes };
    case 'stopped':
      return { tone: 'neutral', icon: 'stop', title: `${prefix} stopped`, detail, notes };
    default:
      return { tone: 'danger', icon: 'x', title: `${prefix} failed`, detail, notes, error };
  }
}

// -----------------------------------------------------------------------------
// Failure card
// -----------------------------------------------------------------------------

export interface FailureCardData {
  /** Slugified id of the canvas node (its step id). */
  nodeStepId: string;
  nodeLabel: string;
  /** Engine id of the failed instance; differs from the node id for wildcard steps. */
  engineId: string;
  headline: string;
  /** What went wrong, in plain words. */
  what: string;
  /** The blocking output check that failed, in the engine's words. */
  check?: string;
  /** Last lines the command wrote to stderr. */
  stderr: string[];
  /** Steps that did not run because of this failure. */
  notRun: number;
}

/** The engine's reason for a failure as a sentence a biologist can act on. */
export function plainFailure(message: string | undefined): string {
  const text = (message ?? '').trim();
  if (/timed out/i.test(text)) {
    return 'The step took longer than its time limit and was stopped.';
  }
  if (/^output check failed/i.test(text)) {
    return 'The step finished, but its result did not pass a check.';
  }
  if (text === '' || /See logs for details\.?$/i.test(text)) {
    return 'The command ended with an error.';
  }
  return text;
}

/** The output-check names as the properties panel shows them. */
const CHECK_NAMES: Record<string, (lines?: string) => string> = {
  exists: () => 'Outputs must exist',
  non_empty: () => 'Outputs must be non-empty',
  min_lines: (lines) => (lines ? `At least ${lines} lines` : 'At least N lines'),
};

/**
 * An engine check failure ("non_empty on all outputs: empty.txt: is empty")
 * as a sentence that names the file, the check as the panel labels it, and
 * what to do. Text in another shape is returned unchanged.
 */
export function plainCheck(message: string | undefined): string {
  const text = (message ?? '').trim();
  const m = /^(exists|non_empty|min_lines)(?: (\d+))? on .+?(?: \(non-blocking\))?: (.+)$/.exec(text);
  if (!m) return text;
  const name = CHECK_NAMES[m[1]](m[2]);
  const detail = m[3];
  if (detail === 'no matching output to check') {
    return `"${name}" is on, but no output matches what it should check. Pick another output for it.`;
  }
  const split =
    /^(.*?): (does not exist|is empty|has \d+ lines?, expected at least \d+|is a directory, so lines cannot be counted|cannot be read.*)$/.exec(
      detail
    );
  const what = split ? `${split[1]} ${split[2]}` : detail;
  return `${what}, but "${name}" is on. Check the command, or turn the check off.`;
}

/**
 * Describes the first failed step, in canvas order, or null when nothing
 * failed. `logs` is the raw log, searched for the step's stderr.
 */
export function buildFailureCard(
  runs: StepRuns,
  nodes: ReadonlyArray<{ stepId: string; label: string }>,
  logs: readonly string[]
): FailureCardData | null {
  const baseIds = nodes.map((n) => n.stepId);
  const statuses = rollupNodeStatuses(runs, baseIds);
  const node = nodes.find((n) => statuses[n.stepId]?.state === 'failed');
  if (!node) return null;
  const status = statuses[node.stepId];
  const engineId = status.failedStepId ?? node.stepId;

  const notRun = Object.entries(runs).filter(([id, r]) => {
    const base = resolveBaseStepId(id, baseIds);
    return base !== null && base !== node.stepId && r.state === 'skipped' && !r.upToDate;
  }).length;

  return {
    nodeStepId: node.stepId,
    nodeLabel: node.label,
    engineId,
    headline: `"${node.label}" failed`,
    what: plainFailure(status.message),
    check: status.failedCheck ? plainCheck(status.failedCheck) : undefined,
    stderr: extractStderrTail(logs, engineId),
    notRun,
  };
}

/** Which section of the properties panel to open for "Edit step". */
export function sectionToEdit(
  card: Pick<FailureCardData, 'check' | 'what'>
): Extract<SectionId, 'checks' | 'reliability' | 'advanced'> {
  if (card.check) return 'checks';
  if (/time limit/i.test(card.what)) return 'reliability';
  return 'advanced';
}
