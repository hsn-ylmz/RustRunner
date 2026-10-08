/**
 * Presentation helpers for "Resume last run". Pure, so they can be unit-tested.
 *
 * The saved run itself is the engine's: it persists which steps finished and
 * resumes from there unless started with `--fresh`. The main process reads that
 * state (src/main/resumeState.ts) and hands the renderer this summary.
 */

/** Mirrors ResumeInfo in src/main/resumeState.ts. */
export interface ResumeInfo {
  canResume: boolean;
  completedCount: number;
  failedStep: string | null;
  savedAt: number | null;
  workflowName: string | null;
  workflowVersion: string | null;
}

/** Saved-run part of the Run button tooltip. */
export function describeResume(
  info: ResumeInfo | null,
  hasWorkingDirectory: boolean,
  formatTime: (ms: number) => string = (ms) => new Date(ms).toLocaleString()
): string {
  if (!hasWorkingDirectory) {
    return 'Set a working directory first; a saved run is looked up there.';
  }
  if (!info || !info.canResume) {
    return 'No saved run for this workflow in the working directory yet.';
  }

  const parts = [
    `${info.completedCount} step${info.completedCount === 1 ? '' : 's'} already finished`,
  ];
  if (info.failedStep) parts.push(`last run stopped at "${info.failedStep}"`);
  if (info.savedAt !== null) parts.push(`saved ${formatTime(info.savedAt)}`);
  return `Continue the last run: ${parts.join(', ')}. Finished steps are skipped.`;
}
