import { useEffect, useRef, useCallback, type ReactNode } from 'react';

export type ExecutionTab = 'logs' | 'steps' | 'history';

/**
 * Picks a severity class for one log line.
 *
 * Ordered most- to least-specific: the engine's own `[ERROR]`/`[WARN]` prefixes
 * win over keyword sniffing, so a command that merely mentions "error" isn't
 * painted red. Applied per line rather than per stdout chunk.
 */
export function classifyLogLine(line: string): string {
  if (/^\s*\[ERROR\]/.test(line)) return 'error';
  if (/^\s*\[WARN\]/.test(line)) return 'warning';
  if (/^\s*\[(PAUSED|STOPPED)\]/.test(line)) return 'warning';
  if (/completed successfully|Workflow completed/i.test(line)) return 'success';
  if (/\bfailed\b|Execution error/i.test(line)) return 'error';
  if (/stopped by user|paused/i.test(line)) return 'warning';
  if (/\[DRY RUN\]|Wildcards|Starting step:/i.test(line)) return 'info';
  return '';
}

export function ExecutionLogs({
  logs,
  visible,
  onClear,
  onToggle,
  tab = 'logs',
  onTabChange,
  stepCount = 0,
  stepsView,
  historyView,
  historyCount = 0,
  latestReport = false,
  onOpenLatestReport,
}: {
  logs: string[];
  visible: boolean;
  onClear: () => void;
  onToggle: () => void;
  /** Which view is showing. Without `stepsView` the panel is just the log. */
  tab?: ExecutionTab;
  onTabChange?: (tab: ExecutionTab) => void;
  stepCount?: number;
  stepsView?: ReactNode;
  /** The run history tab; shown when given. */
  historyView?: ReactNode;
  historyCount?: number;
  /** True once a run has produced a report that can be opened. */
  latestReport?: boolean;
  onOpenLatestReport?: () => void;
}) {
  const showHistory = Boolean(historyView) && tab === 'history';
  const showSteps = Boolean(stepsView) && tab === 'steps';
  const showLogs = !showSteps && !showHistory;
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logContentRef = useRef<HTMLDivElement>(null);
  /** False while the user has scrolled up, so new output doesn't yank them back. */
  const stickToBottomRef = useRef(true);

  // Auto-scroll logs, but only while the user is already at the bottom.
  useEffect(() => {
    if (stickToBottomRef.current) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const handleLogScroll = useCallback(() => {
    const el = logContentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 40;
  }, []);

  return (
    <div className={`execution-panel ${visible ? 'visible' : 'hidden'}`}>
      <div className="execution-panel-header">
        {stepsView && onTabChange ? (
          <div className="execution-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'logs'}
              data-testid="tab-logs"
              className={`execution-tab ${tab === 'logs' ? 'active' : ''}`}
              onClick={() => onTabChange('logs')}
            >
              Execution Logs
            </button>
            <button
              role="tab"
              aria-selected={tab === 'steps'}
              data-testid="tab-steps"
              className={`execution-tab ${tab === 'steps' ? 'active' : ''}`}
              onClick={() => onTabChange('steps')}
            >
              Step Status{stepCount > 0 ? ` (${stepCount})` : ''}
            </button>
            {historyView && (
              <button
                role="tab"
                aria-selected={tab === 'history'}
                data-testid="tab-history"
                className={`execution-tab ${tab === 'history' ? 'active' : ''}`}
                onClick={() => onTabChange('history')}
              >
                Run History{historyCount > 0 ? ` (${historyCount})` : ''}
              </button>
            )}
          </div>
        ) : (
          <h3>Execution Logs</h3>
        )}
        <div className="execution-panel-controls">
          {latestReport && onOpenLatestReport && (
            <button
              className="panel-button"
              data-testid="open-latest-report"
              onClick={onOpenLatestReport}
              title="Open the HTML report of the last run"
            >
              Open latest report
            </button>
          )}
          {showLogs && (
            <button className="panel-button" onClick={onClear}>Clear</button>
          )}
          <button className="panel-button" onClick={onToggle}>
            {visible ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {visible && showSteps && (
        <div className="execution-panel-content">{stepsView}</div>
      )}
      {visible && showHistory && (
        <div className="execution-panel-content">{historyView}</div>
      )}
      {visible && showLogs && (
        <div
          className="execution-panel-content"
          ref={logContentRef}
          onScroll={handleLogScroll}
        >
          {logs.map((log, index) => (
            <div key={index} className={`log-entry ${classifyLogLine(log)}`} data-testid="log-entry">
              {log}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      )}
    </div>
  );
}
