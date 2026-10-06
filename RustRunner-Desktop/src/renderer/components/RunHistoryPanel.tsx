import type { RunHistoryEntry } from '../../main/runHistory';
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
  onOpenReport,
}: {
  runs: RunHistoryEntry[];
  hasWorkingDirectory: boolean;
  onOpenReport: (report: string) => void;
}) {
  if (!hasWorkingDirectory) {
    return (
      <div className="step-status-empty" data-testid="history-empty">
        Run the workflow to build its history. Each run is kept in the working directory.
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="step-status-empty" data-testid="history-empty">
        No runs of this workflow in this working directory yet. Dry runs are not recorded.
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
                <span className="step-glyph">{STATUS_TEXT[run.status].glyph}</span>{' '}
                {STATUS_TEXT[run.status].label}
              </td>
              <td>{formatStarted(run)}</td>
              <td>{formatDuration(run.durationSecs)}</td>
              <td>{formatCounts(run)}</td>
              <td>
                <button
                  className="panel-button"
                  data-testid="open-report"
                  onClick={() => onOpenReport(run.report)}
                >
                  Open report
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
