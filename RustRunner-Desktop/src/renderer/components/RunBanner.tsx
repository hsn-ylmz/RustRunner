import { Badge, Button, Callout, Icon, IconButton } from '../ui';
import type { FailureCardData, RunSummaryView, SetupProblemView } from '../runFeedback';
import { SetupProblemCard } from './SetupProblemCard';

/**
 * How the last run ended, above the run output: one line with the outcome,
 * duration and counts, and for a failure a card that says which step failed,
 * why, what the command printed and what to do about it. Dismissed with the
 * close button; a new run clears it.
 */
export function RunBanner({
  summary,
  failure,
  setup,
  hasReport,
  onOpenReport,
  onShowLogs,
  onEditStep,
  onDismiss,
}: {
  summary: RunSummaryView;
  failure: FailureCardData | null;
  /** The run could not start; shown instead of the engine's error line. */
  setup?: SetupProblemView | null;
  hasReport: boolean;
  onOpenReport: () => void;
  onShowLogs: () => void;
  onEditStep: (card: FailureCardData) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="run-banner-stack">
      <div
        className={`run-banner run-banner-${summary.tone}`}
        role="status"
        data-testid="run-summary"
        data-outcome={summary.tone}
      >
        <Icon name={summary.icon} size={16} className="run-banner-icon" />
        <strong className="run-banner-title" data-testid="run-summary-title">
          {summary.title}
        </strong>
        <span className="run-banner-detail" data-testid="run-summary-detail">
          {summary.detail}
        </span>
        {summary.notes.map((note) => (
          <Badge key={note} tone="warning" variant="outline">
            {note}
          </Badge>
        ))}
        <span className="run-banner-spacer" />
        {hasReport && !failure && (
          <Button size="sm" data-testid="summary-open-report" onClick={onOpenReport}>
            Open report
          </Button>
        )}
        <IconButton
          icon="x"
          size="sm"
          label="Dismiss run summary"
          data-testid="summary-dismiss"
          onClick={onDismiss}
        />
      </div>

      {setup && !failure && <SetupProblemCard problem={setup} />}

      {summary.error && !failure && !setup && (
        <Callout tone="danger" data-testid="run-error">
          {summary.error}
        </Callout>
      )}

      {failure && (
        <div className="failure-card" data-testid="failure-card" role="group" aria-label="Failed step">
          <div className="failure-main">
            <div className="failure-head">
              <h4 className="failure-title" data-testid="failure-title">
                <Icon name="x" size={14} /> {failure.headline}
              </h4>
              <div className="failure-actions">
                <Button
                  size="sm"
                  data-testid="failure-show-report"
                  disabledReason={hasReport ? undefined : 'This run has no report'}
                  onClick={onOpenReport}
                >
                  Show in report
                </Button>
                <Button size="sm" data-testid="failure-show-logs" onClick={onShowLogs}>
                  Show logs
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  data-testid="failure-edit-step"
                  onClick={() => onEditStep(failure)}
                >
                  Edit step
                </Button>
              </div>
            </div>
            <p className="failure-what" data-testid="failure-what">
              {failure.what}
            </p>
            {failure.check && (
              <Callout tone="danger" icon="alert" data-testid="failure-check">
                <strong>Check that failed:</strong> {failure.check}
              </Callout>
            )}
            {failure.notRun > 0 && (
              <p className="failure-note">
                {failure.notRun} later {failure.notRun === 1 ? 'step' : 'steps'} did not run because
                of this.
              </p>
            )}
          </div>
          {failure.stderr.length > 0 && (
            <figure className="failure-output">
              <figcaption>Last lines the command printed</figcaption>
              <pre data-testid="failure-stderr" tabIndex={0}>
                {failure.stderr.join('\n')}
              </pre>
            </figure>
          )}
        </div>
      )}
    </div>
  );
}
