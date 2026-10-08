/** The run column's state line: what the workflow is doing right now. Pure, for unit tests. */

import type { BadgeTone, IconName } from './ui';

export type RunOutcome = 'success' | 'failed' | 'stopped';

export interface RunStateInput {
  executionState: 'idle' | 'running' | 'paused';
  /** A dry run is in flight (it does not use the running state). */
  dryRun: boolean;
  /** How the last run ended; null before any run in this session. */
  outcome: RunOutcome | null;
  /** Steps finished so far and steps on the canvas. */
  finished: number;
  total: number;
}

export interface RunStateView {
  tone: BadgeTone;
  icon: IconName;
  label: string;
}

export function describeRunState(s: RunStateInput): RunStateView {
  if (s.executionState === 'paused') {
    return { tone: 'warning', icon: 'pause', label: 'Paused' };
  }
  if (s.executionState === 'running') {
    const progress = s.total > 0 ? `, ${s.finished} of ${s.total} steps` : '';
    return { tone: 'accent', icon: 'play', label: `Running${progress}` };
  }
  if (s.dryRun) {
    return { tone: 'info', icon: 'info', label: 'Checking (dry run)' };
  }
  switch (s.outcome) {
    case 'success':
      return { tone: 'success', icon: 'check', label: 'Last run succeeded' };
    case 'failed':
      return { tone: 'danger', icon: 'x', label: 'Last run failed' };
    case 'stopped':
      return { tone: 'neutral', icon: 'stop', label: 'Last run stopped' };
    default:
      return { tone: 'neutral', icon: 'circle', label: 'Ready' };
  }
}

/** One sentence per control, shown in its tooltip. */
export const RUN_TOOLTIPS = {
  run: 'Run the workflow. Steps whose results are already up to date are skipped.',
  fromScratch: 'Throw away saved progress and run every step again.',
  dryRun: 'Check the workflow and list what would run, without running anything.',
  pause: 'Hold before the next step starts; a step already running finishes first.',
  stop: 'Stop the run now and end the running step.',
} as const;
