import {
  summarizeRows,
  type RunPhase,
  type StatusRow,
  type StepState,
} from '../stepEvents';

/** Human wording and glyph for each state, shared with the canvas badges. */
const STATE_TEXT: Record<StepState, { glyph: string; label: string }> = {
  pending: { glyph: '○', label: 'Pending' },
  running: { glyph: '●', label: 'Running' },
  retrying: { glyph: '↻', label: 'Retrying' },
  succeeded: { glyph: '✓', label: 'Succeeded' },
  failed: { glyph: '✕', label: 'Failed' },
  skipped: { glyph: '⏭', label: 'Skipped' },
};

const SUMMARY_ORDER: StepState[] = [
  'running',
  'retrying',
  'pending',
  'succeeded',
  'failed',
  'skipped',
];

/**
 * Live per-step status, fed by the same engine log events as the canvas
 * badges: one row per engine step (a wildcard node shows one per file).
 */
export function StepStatusPanel({
  rows,
  phase,
}: {
  rows: StatusRow[];
  phase: RunPhase;
}) {
  if (phase === 'none' || rows.length === 0) {
    return (
      <div className="step-status-empty">
        Run or dry-run the workflow to see each step's status here.
      </div>
    );
  }

  const counts = summarizeRows(rows);

  return (
    <div className="step-status" data-testid="step-status">
      <div className="step-status-summary">
        {SUMMARY_ORDER.filter((state) => counts[state] > 0).map((state) => (
          <span key={state} className={`step-chip step-state-${state}`}>
            {STATE_TEXT[state].glyph} {counts[state]} {STATE_TEXT[state].label.toLowerCase()}
          </span>
        ))}
      </div>

      <table className="step-status-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Step</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={`step-row step-state-${row.state}`}
              data-testid="step-row"
              data-step-id={row.id}
              data-state={row.state}
            >
              <td className="step-row-state">
                <span className="step-glyph">{STATE_TEXT[row.state].glyph}</span>{' '}
                {STATE_TEXT[row.state].label}
              </td>
              <td title={row.label}>{row.id}</td>
              <td className="step-row-details">{rowDetails(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function rowDetails(row: StatusRow): string {
  if (row.state === 'failed') return row.message || 'Step failed';
  if (row.state === 'retrying' && row.attempt && row.maxAttempts) {
    return `attempt ${row.attempt} of ${row.maxAttempts} failed, waiting to retry`;
  }
  if (row.attempt && row.maxAttempts && row.maxAttempts > 1) {
    return `attempt ${row.attempt} of ${row.maxAttempts}`;
  }
  if (row.state === 'skipped') return 'finished in an earlier run, or not reached';
  return '';
}
