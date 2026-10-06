/**
 * The list of everything that stops a run. Each line names the step and says
 * what to do; clicking it selects the step and puts the cursor in the field.
 */

import { IconButton, Icon, Panel } from '../ui';
import { issueCountLabel, type ValidationIssue } from '../validation';

export function ProblemsPanel({
  issues,
  onSelect,
  onClose,
}: {
  issues: ValidationIssue[];
  onSelect: (issue: ValidationIssue) => void;
  onClose: () => void;
}) {
  return (
    <Panel
      className="problems-panel"
      data-testid="problems-panel"
      role="region"
      aria-label="Problems to fix before running"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
      title={`Fix before running (${issueCountLabel(issues.length)})`}
      actions={
        <IconButton
          icon="x"
          label="Close the problem list"
          size="sm"
          onClick={onClose}
          data-testid="problems-close"
        />
      }
    >
      <ul className="problems-list">
        {issues.map((issue) => (
          <li key={issue.id}>
            <button
              type="button"
              className="problem-item"
              data-testid="problem-item"
              data-node-id={issue.nodeId}
              onClick={() => onSelect(issue)}
            >
              <Icon name="alert" size={14} className="problem-icon" />
              <span className="problem-text">
                {issue.nodeLabel && <strong className="problem-step">{issue.nodeLabel}</strong>}
                <span>{issue.message}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
