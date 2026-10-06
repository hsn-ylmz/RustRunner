import { useEffect, useRef, useCallback, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '../ui';

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

  const tabs: Array<{ id: ExecutionTab; label: string; testId: string }> = [
    { id: 'logs', label: 'Execution logs', testId: 'tab-logs' },
    { id: 'steps', label: `Step status${stepCount > 0 ? ` (${stepCount})` : ''}`, testId: 'tab-steps' },
    ...(historyView
      ? [
          {
            id: 'history' as ExecutionTab,
            label: `Run history${historyCount > 0 ? ` (${historyCount})` : ''}`,
            testId: 'tab-history',
          },
        ]
      : []),
  ];

  /** Arrow keys, Home and End move between tabs (the tablist pattern). */
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!onTabChange || !keys.includes(e.key)) return;
    const at = tabs.findIndex((t) => t.id === tab);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? tabs.length - 1
          : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    onTabChange(tabs[next].id);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  const panelProps = (id: ExecutionTab) => ({
    role: 'tabpanel',
    id: `execution-tabpanel-${id}`,
    'aria-labelledby': `execution-tab-${id}`,
  });

  return (
    <div className={`execution-panel ${visible ? 'visible' : 'hidden'}`}>
      <div className="execution-panel-header">
        {stepsView && onTabChange ? (
          <div className="execution-tabs" role="tablist" aria-label="Run output" onKeyDown={onTabKeyDown}>
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`execution-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`execution-tabpanel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                data-testid={t.testId}
                className={`execution-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => onTabChange(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : (
          <h3>Execution logs</h3>
        )}
        <div className="execution-panel-controls">
          {latestReport && onOpenLatestReport && (
            <Button
              size="sm"
              data-testid="open-latest-report"
              onClick={onOpenLatestReport}
              title="Open the HTML report of the last run"
            >
              Open latest report
            </Button>
          )}
          {showLogs && (
            <Button size="sm" onClick={onClear}>
              Clear log
            </Button>
          )}
          <Button size="sm" onClick={onToggle} aria-expanded={visible}>
            {visible ? 'Hide' : 'Show'}
          </Button>
        </div>
      </div>
      {visible && showSteps && (
        <div className="execution-panel-content" {...panelProps('steps')}>
          {stepsView}
        </div>
      )}
      {visible && showHistory && (
        <div className="execution-panel-content" {...panelProps('history')}>
          {historyView}
        </div>
      )}
      {visible && showLogs && (
        <div
          className="execution-panel-content log-content"
          {...panelProps('logs')}
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
