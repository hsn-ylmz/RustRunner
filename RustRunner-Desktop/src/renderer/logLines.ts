/**
 * Log line handling for the execution panel: severity, filtering, search and
 * the text that "Copy" puts on the clipboard. Pure, so it can be unit-tested.
 */

export type Severity = 'error' | 'warning' | 'success' | 'info' | '';

export type LogFilter = 'all' | 'errors' | 'warnings';

/**
 * Picks a severity for one log line.
 *
 * Ordered most- to least-specific: the engine's own `[ERROR]`/`[WARN]` prefixes
 * win over keyword sniffing, so a command that merely mentions "error" isn't
 * painted red. Applied per line rather than per stdout chunk.
 */
export function classifyLogLine(line: string): Severity {
  if (/^\s*\[ERROR\]/.test(line)) return 'error';
  if (/^\s*\[WARN\]/.test(line)) return 'warning';
  if (/^\s*\[(PAUSED|STOPPED)\]/.test(line)) return 'warning';
  if (/completed successfully|Workflow completed/i.test(line)) return 'success';
  if (/\bfailed\b|Execution error/i.test(line)) return 'error';
  if (/stopped by user|paused/i.test(line)) return 'warning';
  if (/\[DRY RUN\]|Wildcards|Starting step:/i.test(line)) return 'info';
  return '';
}

/** The engine's header of a failed command's captured stderr. */
const STDERR_HEADER = /^\s*\[ERROR\]\s*stderr:\s*$/;

/**
 * Severity of every line. The engine writes a failed command's stderr as a
 * header line followed by the raw text; those lines carry no prefix of their
 * own, so they take the severity of the header until the next line that is
 * classified by itself. Without this the "Errors" filter would show the header
 * and hide the message under it.
 */
export function classifyLogLines(lines: readonly string[]): Severity[] {
  const out: Severity[] = [];
  let inStderr = false;
  for (const line of lines) {
    const own = classifyLogLine(line);
    if (STDERR_HEADER.test(line)) {
      inStderr = true;
      out.push('error');
    } else if (own !== '') {
      inStderr = false;
      out.push(own);
    } else {
      out.push(inStderr ? 'error' : '');
    }
  }
  return out;
}

export interface LogRow {
  /** Index in the full log, a stable React key. */
  index: number;
  line: string;
  severity: Severity;
}

/** Lines that pass the severity filter and contain the search text (case-insensitive). */
export function filterLogLines(
  lines: readonly string[],
  filter: LogFilter,
  query: string
): LogRow[] {
  const severities = classifyLogLines(lines);
  const needle = query.trim().toLowerCase();
  const rows: LogRow[] = [];
  lines.forEach((line, index) => {
    const severity = severities[index];
    if (filter === 'errors' && severity !== 'error') return;
    if (filter === 'warnings' && severity !== 'warning') return;
    if (needle && !line.toLowerCase().includes(needle)) return;
    rows.push({ index, line, severity });
  });
  return rows;
}

/** The text copied for the visible lines. */
export function logsToText(rows: readonly LogRow[]): string {
  return rows.map((r) => r.line).join('\n');
}

/** "12 lines", "3 of 340 lines": what the panel says about what it shows. */
export function describeLogCount(shown: number, total: number): string {
  const unit = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;
  return shown === total ? unit(total) : `${shown} of ${unit(total)}`;
}

/**
 * The last lines a failed step wrote to stderr, taken from the log.
 *
 * Finds the last "Step '<id>' failed with exit code" (or timeout) message of
 * that step, then the stderr block that follows it. The block ends at the next
 * engine message or at an app message, which both start with a bracket or a
 * known engine phrase. Returns at most `max` lines, the end of the block.
 */
export function extractStderrTail(
  lines: readonly string[],
  stepId: string,
  max = 6
): string[] {
  const marker = new RegExp(
    `^\\s*\\[ERROR\\]\\s*Step '${stepId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' (failed with exit code|exceeded its)`
  );
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (marker.test(lines[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) return [];

  let i = at + 1;
  while (i < lines.length && !STDERR_HEADER.test(lines[i])) {
    // Another engine message before any stderr: this attempt wrote none.
    if (/^\s*\[(ERROR|WARN)\]/.test(lines[i]) || /^Starting step:/.test(lines[i])) return [];
    i++;
  }
  if (i >= lines.length) return [];

  const block: string[] = [];
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\[(ERROR|WARN|PAUSED|STOPPED)\]/.test(line)) break;
    if (/^Starting step:|^Workflow |^\[\d/.test(line)) break;
    block.push(line.trimEnd());
  }
  return block.slice(-max);
}
