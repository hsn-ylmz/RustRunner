import { useEffect, useMemo, useRef, useCallback, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Icon, TextField, type Notify } from '../ui';
import { describeLogCount, filterLogLines, logsToText, type LogFilter } from '../logLines';

export type ExecutionTab = 'logs' | 'steps' | 'history';

export { classifyLogLine } from '../logLines';

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
  banner,
  bannerSize,
  onNotify,
  filter: controlledFilter,
  onFilterChange,
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
  /** The end-of-run summary and failure card, shown above the tab content. */
  banner?: ReactNode;
  /** Makes room for the banner: a one-line summary, or the failure card too. */
  bannerSize?: 'summary' | 'failure';
  onNotify?: Notify;
  /** The severity filter, when the editor sets it (the failure card's "Show logs"). */
  filter?: LogFilter;
  onFilterChange?: (filter: LogFilter) => void;
}) {
  const showHistory = Boolean(historyView) && tab === 'history';
  const showSteps = Boolean(stepsView) && tab === 'steps';
  const showLogs = !showSteps && !showHistory;
  const logContentRef = useRef<HTMLDivElement>(null);
  const [ownFilter, setOwnFilter] = useState<LogFilter>('all');
  const filter = controlledFilter ?? ownFilter;
  const setFilter = onFilterChange ?? setOwnFilter;
  const [query, setQuery] = useState('');
  /** Follow new output. Scrolling up turns it off, scrolling back to the end (or the toggle) on. */
  const [follow, setFollow] = useState(true);

  const rows = useMemo(() => filterLogLines(logs, filter, query), [logs, filter, query]);

  // Follow the output while it is on.
  useEffect(() => {
    const el = logContentRef.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [rows, follow, showLogs, visible]);

  const handleLogScroll = useCallback(() => {
    const el = logContentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollow(distanceFromBottom < 40);
  }, []);

  const copyVisible = useCallback(async () => {
    const text = logsToText(rows);
    try {
      await navigator.clipboard.writeText(text);
      onNotify?.('success', `Copied ${describeLogCount(rows.length, rows.length)} to the clipboard`);
    } catch {
      onNotify?.('danger', 'Could not copy the log. Select the text and copy it instead.');
    }
  }, [rows, onNotify]);

  const filtering = filter !== 'all' || query.trim() !== '';

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
    <div
      className={`execution-panel ${visible ? 'visible' : 'hidden'}${
        banner && bannerSize ? ` has-${bannerSize}` : ''
      }`}
    >
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
      {banner && visible && <div className="execution-banner">{banner}</div>}
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
        <div className="log-view" {...panelProps('logs')}>
          <div className="log-toolbar" role="toolbar" aria-label="Log tools">
            <div className="log-filter" role="group" aria-label="Show">
              {(
                [
                  ['all', 'All'],
                  ['errors', 'Errors'],
                  ['warnings', 'Warnings'],
                ] as Array<[LogFilter, string]>
              ).map(([id, label]) => (
                <Button
                  key={id}
                  size="sm"
                  variant="ghost"
                  pressed={filter === id}
                  aria-pressed={filter === id}
                  data-testid={`log-filter-${id}`}
                  onClick={() => setFilter(id)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <TextField
              label="Search the log"
              hideLabel
              type="search"
              placeholder="Search the log"
              value={query}
              data-testid="log-search"
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="log-count" data-testid="log-count">
              {describeLogCount(rows.length, logs.length)}
            </span>
            <div className="log-toolbar-actions">
              <Button
                size="sm"
                variant="ghost"
                pressed={follow}
                aria-pressed={follow}
                data-testid="log-follow"
                tooltip="Keep the newest line in view"
                onClick={() => setFollow((f) => !f)}
              >
                Follow output
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="file"
                data-testid="log-copy"
                disabledReason={rows.length === 0 ? 'There is nothing to copy' : undefined}
                onClick={copyVisible}
              >
                Copy
              </Button>
            </div>
          </div>
          <div
            className="execution-panel-content log-content"
            ref={logContentRef}
            onScroll={handleLogScroll}
            tabIndex={0}
            aria-label="Log lines"
          >
            {rows.length === 0 && (
              <div className="log-empty" data-testid="log-empty">
                <Icon name={filtering ? 'info' : 'circle'} size={16} />
                {filtering ? (
                  <span>
                    No lines match.{' '}
                    <button
                      type="button"
                      className="link-button"
                      data-testid="log-reset-filter"
                      onClick={() => {
                        setFilter('all');
                        setQuery('');
                      }}
                    >
                      Show all lines
                    </button>
                  </span>
                ) : (
                  <span>No output yet. Messages from a run appear here as it goes.</span>
                )}
              </div>
            )}
            {rows.map((row) => (
              <div
                key={row.index}
                className={`log-entry ${row.severity}`}
                data-testid="log-entry"
              >
                {row.line}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
