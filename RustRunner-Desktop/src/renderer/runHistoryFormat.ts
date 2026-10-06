/** Wording for the run history list. Pure, so it can be unit-tested. */

import type { RunHistoryEntry, RunHistoryStatus } from '../main/runHistory';
import type { IconName } from './ui/Icon';

/** "850 ms", "12.3 s", "4 min 07 s", "1 h 02 min". */
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '';
  if (secs < 1) return `${Math.round(secs * 1000)} ms`;
  if (secs < 60) return `${secs.toFixed(1)} s`;
  if (secs < 3600) {
    const total = Math.round(secs);
    return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
  }
  const minutes = Math.round(secs / 60);
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** The start time in the viewer's locale; the raw text when it is not a date. */
export function formatStarted(entry: Pick<RunHistoryEntry, 'startedAt' | 'startedMs'>): string {
  if (entry.startedMs === null) return entry.startedAt;
  return new Date(entry.startedMs).toLocaleString();
}

/** Icon and wording for each run outcome; the icon never stands alone. */
export const STATUS_TEXT: Record<RunHistoryStatus, { icon: IconName; label: string }> = {
  succeeded: { icon: 'check', label: 'Succeeded' },
  failed: { icon: 'x', label: 'Failed' },
  stopped: { icon: 'stop', label: 'Stopped' },
  unknown: { icon: 'info', label: 'Unknown' },
};

/** "3 of 5 steps succeeded, 1 failed, 1 skipped": only the non-zero parts. */
export function formatCounts(entry: RunHistoryEntry): string {
  const parts = [`${entry.succeeded} succeeded`];
  if (entry.failed > 0) parts.push(`${entry.failed} failed`);
  if (entry.skipped > 0) parts.push(`${entry.skipped} skipped`);
  return `${parts.join(', ')} of ${entry.total}`;
}
