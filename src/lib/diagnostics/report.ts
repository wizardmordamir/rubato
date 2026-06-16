/**
 * Pure diagnostics report model: the overview shape that `session.finish()`
 * writes as `<activity>-<ts>-<id>.report.json`, plus error classification. No
 * fs / config / process — the impure `session.ts` supplies the redacted env /
 * config snapshots and the timestamps; this file just classifies and assembles,
 * so it's unit-testable with plain inputs.
 */

import type { ShapeDiff } from './shape';

/** Overall outcome of a diagnosed activity. */
export type DiagnosticStatus = 'ok' | 'warn' | 'error';

/** Coarse error bucket — the first thing you sort failures by across machines. */
export type ErrorClass =
  | 'network'
  | 'timeout'
  | 'http-4xx'
  | 'http-5xx'
  | 'parse-shape'
  | 'missing-optional-dep'
  | 'unknown';

/** One step/event in the activity's timeline (also written to the JSONL log). */
export interface DiagnosticEvent {
  /** ISO timestamp. */
  ts: string;
  level: 'debug' | 'info' | 'step' | 'warn' | 'error';
  msg: string;
  /** Optional structured payload (already redacted by the session). */
  data?: unknown;
}

/** A normalized, loggable view of whatever was thrown. */
export interface DiagnosticError {
  message: string;
  name?: string;
  classification: ErrorClass;
  stack?: string;
  /** From an `ApiError`-like throw: the HTTP context, when present. */
  status?: number;
  statusText?: string;
  url?: string;
  method?: string;
  /** A short, redacted preview of the response/error body. */
  bodySnippet?: string;
}

/** A recorded shape comparison (from `session.expected(...)`). */
export interface ShapeMismatch {
  label: string;
  expected: string;
  actual: string;
  diffs: ShapeDiff[];
}

/** The overview report. Mirrors the activity at a glance; the JSONL log has detail. */
export interface DiagnosticReport {
  schema: 'rubato.diagnostic/1';
  id: string;
  correlationId: string;
  activity: string;
  intent?: string;
  status: DiagnosticStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  counts: { steps: number; warnings: number; errors: number; shapeMismatches: number };
  error?: DiagnosticError;
  shapeMismatches: ShapeMismatch[];
  /** Redacted snapshot of relevant env vars (supplied by the session). */
  env?: Record<string, string>;
  /** Redacted snapshot of the active config (supplied by the session). */
  config?: unknown;
  /** Host facts that often explain machine-specific failures. */
  host: { platform: string; bun?: string; cwd?: string };
  /** Path to the companion JSONL log. */
  logPath?: string;
}

/** Read a property off an unknown value without throwing. */
function prop<T = unknown>(obj: unknown, key: string): T | undefined {
  return obj && typeof obj === 'object' ? ((obj as Record<string, unknown>)[key] as T | undefined) : undefined;
}

/**
 * Bucket a thrown value. Duck-typed (reads `.status`/`.name`/`.message`) so an
 * `ApiError` classifies without this pure file importing `src/api`.
 */
export function classifyError(err: unknown): ErrorClass {
  const name = String(prop(err, 'name') ?? '');
  const message = String(prop(err, 'message') ?? (typeof err === 'string' ? err : ''));
  const status = prop<number>(err, 'status');

  if (name === 'TimeoutError' || /timed out/i.test(message)) return 'timeout';
  if (typeof status === 'number') {
    if (status === 0) return /timeout/i.test(String(prop(err, 'statusText') ?? '')) ? 'timeout' : 'network';
    if (status >= 400 && status < 500) return 'http-4xx';
    if (status >= 500 && status < 600) return 'http-5xx';
  }
  if (/\b(unexpected token|not valid json|json parse|invalid json)\b/i.test(message)) return 'parse-shape';
  if (
    /optional peer|is not installed|cannot find (module|package)|@huggingface\/transformers|run `?bun add/i.test(
      message,
    )
  ) {
    return 'missing-optional-dep';
  }
  if (/network|fetch failed|econnrefused|enotfound|socket hang/i.test(message)) return 'network';
  return 'unknown';
}

/**
 * Normalize a thrown value into a `DiagnosticError`. `messageOf` lets the impure
 * session pass cwip's `getMessageFromError` for nicer messages; defaults to a
 * plain read so this file stays dependency-free.
 */
export function toDiagnosticError(err: unknown, messageOf: (e: unknown) => string = defaultMessageOf): DiagnosticError {
  const out: DiagnosticError = { message: messageOf(err), classification: classifyError(err) };
  const name = prop<string>(err, 'name');
  if (name) out.name = name;
  const stack = prop<string>(err, 'stack');
  if (typeof stack === 'string') out.stack = stack;
  for (const k of ['status', 'statusText', 'url', 'method'] as const) {
    const v = prop(err, k);
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

function defaultMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
