/**
 * A bounded, in-memory ring of recent server log lines, each tagged with the
 * correlation id in scope when it was emitted (see correlation.ts). It's fed by
 * the diagnostics session recorder (the app's main logging path), so "give me the
 * full server logs for this request" becomes a correlation-id lookup — the missing
 * half of debug capture, which already records the outbound calls a request made.
 */

export interface LogLine {
  ts: string;
  level: string;
  msg: string;
  correlationId?: string;
  /** The diagnostics activity that emitted it (e.g. "automation-foo"). */
  activity?: string;
}

const MAX_LINES = 5000;
const lines: LogLine[] = [];

/** Append a log line; drops the oldest past the cap. */
export function pushLog(line: LogLine): void {
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
}

/** Every buffered line for one correlation id, oldest first. */
export function logsForCorrelation(correlationId: string): LogLine[] {
  return lines.filter((l) => l.correlationId === correlationId);
}

/** The most recent lines (any correlation), for a general tail view. */
export function recentLogs(limit = 500): LogLine[] {
  return lines.slice(-limit);
}

/** Drop everything (tests / manual reset). */
export function clearLogs(): void {
  lines.length = 0;
}
