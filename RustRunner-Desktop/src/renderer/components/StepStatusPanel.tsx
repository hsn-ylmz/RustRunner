import { Badge, Icon } from '../ui';
import { stateView } from '../runFeedback';
import {
  summarizeRows,
  type RunPhase,
  type StatusRow,
  type StepState,
} from '../stepEvents';

const SUMMARY_ORDER: StepState[] = [
  'running',
  'retrying',
  'pending',
  'succeeded',
  'failed',
  'skipped',
];

/**
 * Live per-step status, fed by the same engine run events as the canvas
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
      <div className="panel-state" data-testid="steps-empty">
        <Icon name="info" size={16} />
        <span>Run or dry-run the workflow to see each step's status here.</span>
      </div>
    );
  }

  const counts = summarizeRows(rows);

  return (
    <div className="step-status" data-testid="step-status">
      <div className="step-status-summary">
        {SUMMARY_ORDER.filter((state) => counts[state] > 0).map((state) => (
          <Badge
            key={state}
            tone={stateView(state).tone}
            icon={stateView(state).icon}
            className={`step-chip step-state-${state}`}
          >
            {counts[state]} {stateView(state).label.toLowerCase()}
          </Badge>
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
              data-up-to-date={row.upToDate ? 'true' : undefined}
            >
              <td className="step-row-state">
                <Icon
                  name={stateView(row.state, { upToDate: row.upToDate }).icon}
                  size={14}
                  className="step-glyph"
                />{' '}
                {stateView(row.state, { upToDate: row.upToDate }).label}
                {row.mocked && row.state === 'succeeded' && (
                  <Badge
                    tone="warning"
                    variant="dashed"
                    className="mock-tag"
                    data-testid="step-mocked"
                  >
                    MOCKED
                  </Badge>
                )}
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
  const parts: string[] = [];
  if (row.state === 'retrying' && row.attempt && row.maxAttempts) {
    const wait =
      row.delaySecs && row.delaySecs > 0
        ? `retrying in ${row.delaySecs}s`
        : 'retrying now';
    parts.push(`attempt ${row.attempt}/${row.maxAttempts} failed, ${wait}`);
  } else if (row.attempt && row.maxAttempts && row.maxAttempts > 1) {
    parts.push(`attempt ${row.attempt}/${row.maxAttempts}`);
  }
  if (row.mocked && row.state === 'succeeded') {
    parts.push('tool not run, outputs are placeholders');
  }
  if (row.state === 'skipped') {
    parts.push(row.message || 'up to date, or not reached');
  }
  if (row.warnings && row.warnings.length > 0) {
    parts.push(`check warning: ${row.warnings.join('; ')}`);
  }
  return parts.join(' | ');
}
