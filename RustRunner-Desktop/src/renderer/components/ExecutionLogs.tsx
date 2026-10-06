import { useEffect, useRef, useCallback } from 'react';

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
}: {
  logs: string[];
  visible: boolean;
  onClear: () => void;
  onToggle: () => void;
}) {
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
        <h3>Execution Logs</h3>
        <div className="execution-panel-controls">
          <button className="panel-button" onClick={onClear}>Clear</button>
          <button className="panel-button" onClick={onToggle}>
            {visible ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {visible && (
        <div
          className="execution-panel-content"
          ref={logContentRef}
          onScroll={handleLogScroll}
        >
          {logs.map((log, index) => (
            <div key={index} className={`log-entry ${classifyLogLine(log)}`}>
              {log}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      )}
    </div>
  );
}
