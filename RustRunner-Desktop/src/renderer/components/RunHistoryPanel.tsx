import type { RunHistoryEntry } from '../../main/runHistory';
import { Button, Icon } from '../ui';
import { STATUS_TEXT, formatCounts, formatDuration, formatStarted } from '../runHistoryFormat';

/**
 * The runs of the current workflow in the working directory, newest first,
 * each with a link to its HTML report. The list comes from the engine's run
 * index; opening a report goes through the main process, which only opens
 * reports inside the run folder.
 */
export function RunHistoryPanel({
  runs,
  hasWorkingDirectory,
  status = 'ready',
  onRetry,
  onOpenReport,
}: {
  runs: RunHistoryEntry[];
  hasWorkingDirectory: boolean;
  /** Where the list is: still being read, read, or could not be read. */
  status?: 'loading' | 'ready' | 'error';
  onRetry?: () => void;
  onOpenReport: (report: string) => void;
}) {
  if (!hasWorkingDirectory) {
    return (
      <div className="panel-state" data-testid="history-empty">
        <Icon name="info" size={16} />
        <span>Run the workflow to build its history. Each run is kept in the working directory.</span>
      </div>
    );
  }
  // A list that is being refreshed stays on screen; only an empty one shows the spinner.
  if (status === 'loading' && runs.length === 0) {
    return (
      <div className="panel-state" role="status" data-testid="history-loading">
        <Icon name="spinner" size={16} spin />
        <span>Reading the run history</span>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="panel-state panel-state-error" role="alert" data-testid="history-error">
        <Icon name="alert" size={16} />
        <span>
          The run history could not be read. The working directory may have moved or be
          unavailable.
        </span>
        {onRetry && (
          <Button size="sm" data-testid="history-retry" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="panel-state" data-testid="history-empty">
        <Icon name="info" size={16} />
        <span>
          No runs of this workflow in this working directory yet. Run it once and it appears here
          with a report. Dry runs are not recorded.
        </span>
      </div>
    );
  }

  return (
    <div className="step-status" data-testid="run-history">
      <table className="step-status-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Started</th>
            <th>Duration</th>
            <th>Steps</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.runId}
              className={`step-row history-${run.status}`}
              data-testid="history-row"
              data-run-id={run.runId}
              data-status={run.status}
            >
              <td className="step-row-state">
                <Icon name={STATUS_TEXT[run.status].icon} size={14} className="step-glyph" />{' '}
                {STATUS_TEXT[run.status].label}
              </td>
              <td>{formatStarted(run)}</td>
              <td>{formatDuration(run.durationSecs)}</td>
              <td>{formatCounts(run)}</td>
              <td>
                <Button
                  size="sm"
                  data-testid="open-report"
                  onClick={() => onOpenReport(run.report)}
                >
                  Open report
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
