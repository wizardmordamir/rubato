/**
 * Wire types for debug capture (shared with the UI). A record is the redacted
 * request/response of an outbound API call or DB query, captured automatically
 * while an automation run/step session executes and tagged with the launching
 * request's correlation id (retrieved via GET /api/debug-capture/logs).
 */

/** One captured operation (mirrors cwip's CaptureRecord; already redacted). */
export interface DebugCaptureRecord {
  /** Group label — the host (fetch) or `<dialect>:<connection>` (db). */
  label: string;
  /** "fetch" | "db" | … */
  kind?: string;
  timestamp: string;
  durationMs: number;
  /** What was sent (url/method/headers/body, or sql/params). */
  request: unknown;
  /** What came back, on success. */
  response?: unknown;
  /** The serialized error, on failure. */
  error?: { name: string; message: string; [key: string]: unknown };
  meta?: Record<string, unknown>;
}
