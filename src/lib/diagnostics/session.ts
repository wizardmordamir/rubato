/**
 * The impure half of diagnostics: a session you open around an activity, write
 * step-by-step events to, record failures + shape mismatches on, and `finish()`
 * to flush two artifacts under `<outputDir>/diagnostics/`:
 *   - `<activity>-<ts>-<id>.log.jsonl`     — every event, the full processing detail
 *   - `<activity>-<ts>-<id>.report.json`   — the overview (status, error, counts,
 *                                             shape diffs, redacted env/config)
 *
 * Both are browsable in the Files tab and the admin Diagnostics panel. All logged
 * data is run through cwip's redactor against the ~/.rubato/.env secret values
 * (+ secret-looking process env), so credentials never land in an artifact.
 *
 * Best-effort by contract: a diagnostics failure (bad dir, unserializable data)
 * must never break the activity it wraps — every write is guarded.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  cleanDataForLogging,
  createLogger,
  getMessageFromError,
  type Logger,
  loggingSettings,
  updateLoggingSettings,
} from 'cwip';
import { rubatoEnvMap } from '../../api/env';
import { currentCorrelationId } from '../correlation';
import { pushLog } from '../logAccumulator';
import { ensureOutputDir } from '../runStore';
import {
  type DiagnosticError,
  type DiagnosticEvent,
  type DiagnosticReport,
  type DiagnosticStatus,
  type ShapeMismatch,
  toDiagnosticError,
} from './report';
import { describeShape, diffShape, shapeToString } from './shape';

export interface DiagnosticsOptions {
  /** Short slug for the activity — names the files, e.g. "run", "verifyshas", "ask". */
  activity: string;
  /** One line: what this run was trying to do. */
  intent?: string;
  /** Correlate across systems; generated when omitted. */
  correlationId?: string;
  /** Mirror events to the console (default true). */
  console?: boolean;
  /** Lowest console level to print (default "debug"). */
  consoleLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** Extra env var names to include (redacted) in the report snapshot. */
  envKeys?: string[];
  /** A config object to snapshot (redacted). When omitted, the active config is loaded best-effort. */
  config?: unknown;
}

/** What `finish()` returns — the paths to the written artifacts (absent if writing failed). */
export interface DiagnosticsResult {
  id: string;
  correlationId: string;
  status: DiagnosticStatus;
  logPath?: string;
  reportPath?: string;
}

export interface DiagnosticsSession {
  readonly id: string;
  readonly correlationId: string;
  /** Current worst-seen status (ok → warn → error). */
  readonly status: DiagnosticStatus;
  step(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** Record that `actual`'s shape departed from `expected` — the "JSON isn't what we thought" case. */
  expected(actual: unknown, expected: unknown, label?: string): void;
  /** Record a thrown error (classified, with stack + any HTTP context). Bumps status to error. */
  fail(err: unknown, context?: unknown): void;
  /** Flush the log + report. Idempotent — a second call is a no-op returning the first result. */
  finish(status?: DiagnosticStatus): Promise<DiagnosticsResult>;
}

const SECRET_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|PASS|API[_-]?KEY|APIKEY|\bKEY\b|AUTH|CRED|PRIVATE|SESSION|COOKIE/i;
/** Env values shorter than this aren't masked (too common to redact safely). */
const MIN_SECRET_LEN = 4;
const ENV_SNAPSHOT_KEYS = ['NODE_ENV', 'RUBATO_HOME', 'RUBATO_PORT', 'RUBATO_ON', 'CLAUDE_CONFIG_DIR'];

const statusRank: Record<DiagnosticStatus, number> = { ok: 0, warn: 1, error: 2 };

/** Open a diagnostics session. See module docs. */
export function startDiagnostics(opts: DiagnosticsOptions): DiagnosticsSession {
  const startedAt = new Date();
  const id = shortId();
  // Adopt the in-flight request's correlation id (so a session's logs join that
  // request's outbound calls), falling back to an explicit opt or a fresh id.
  const correlationId = opts.correlationId ?? currentCorrelationId() ?? makeCorrelationIdSafe();
  const events: DiagnosticEvent[] = [];
  const mismatches: ShapeMismatch[] = [];
  let error: DiagnosticError | undefined;
  let worst: DiagnosticStatus = 'ok';
  let result: DiagnosticsResult | undefined;

  // Redaction: mask the values of every ~/.rubato/.env key + secret-looking env
  // var. Set globally because cwip reads `loggingSettings.secretProps`.
  const env = { ...rubatoEnvMap(), ...process.env } as Record<string, string>;
  const secretKeys = Object.keys(env).filter((k) => SECRET_KEY.test(k) && (env[k]?.length ?? 0) >= MIN_SECRET_LEN);
  updateLoggingSettings({ secretProps: Array.from(new Set([...loggingSettings.secretProps, ...secretKeys])) });

  const log: Logger | null =
    opts.console === false
      ? null
      : createLogger({
          level: opts.consoleLevel ?? 'debug',
          toggles: { skipFileDetails: false, skipTimestamps: false },
        });

  function clean(data: unknown): unknown {
    try {
      return cleanDataForLogging(data, env);
    } catch {
      try {
        return { unserializable: shapeToString(describeShape(data)) };
      } catch {
        return String(data);
      }
    }
  }

  function record(level: DiagnosticEvent['level'], msg: string, data?: unknown): void {
    const cleaned = data === undefined ? undefined : clean(data);
    const ts = new Date().toISOString();
    events.push({ ts, level, msg, ...(cleaned === undefined ? {} : { data: cleaned }) });
    // Tee into the correlation-keyed log ring so a request's full server logs are
    // retrievable by its correlation id (debug capture supplies the outbound calls).
    pushLog({ ts, level, msg, correlationId, activity: opts.activity });
    if (level === 'warn' && statusRank[worst] < statusRank.warn) worst = 'warn';
    if (level === 'error' && statusRank[worst] < statusRank.error) worst = 'error';
    if (log) {
      const fn = level === 'step' ? log.info : log[level];
      cleaned === undefined ? fn(`[${opts.activity}] ${msg}`) : fn(`[${opts.activity}] ${msg}`, cleaned);
    }
  }

  return {
    id,
    correlationId,
    get status() {
      return worst;
    },
    step: (m, d) => record('step', m, d),
    debug: (m, d) => record('debug', m, d),
    info: (m, d) => record('info', m, d),
    warn: (m, d) => record('warn', m, d),
    error: (m, d) => record('error', m, d),
    expected(actual, expectedVal, label = 'shape') {
      const diffs = diffShape(actual, expectedVal);
      const mismatch: ShapeMismatch = {
        label,
        expected: shapeToString(describeShape(expectedVal)),
        actual: shapeToString(describeShape(actual)),
        diffs,
      };
      mismatches.push(mismatch);
      record(diffs.length ? 'warn' : 'info', `shape check "${label}"`, mismatch);
    },
    fail(err, context) {
      error = toDiagnosticError(err, getMessageFromError);
      // Redact a short body preview off ApiError-like throws.
      const body = (err as { body?: unknown })?.body;
      if (body != null) error.bodySnippet = snippet(clean(body));
      worst = 'error';
      record('error', `failed: ${error.message}`, context === undefined ? { error } : { error, context });
    },
    async finish(status) {
      if (result) return result;
      const finishedAt = new Date();
      const finalStatus = status ?? worst;
      const report: DiagnosticReport = {
        schema: 'rubato.diagnostic/1',
        id,
        correlationId,
        activity: opts.activity,
        intent: opts.intent,
        status: finalStatus,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        counts: {
          steps: events.filter((e) => e.level === 'step').length,
          warnings: events.filter((e) => e.level === 'warn').length,
          errors: events.filter((e) => e.level === 'error').length,
          shapeMismatches: mismatches.length,
        },
        error,
        shapeMismatches: mismatches,
        env: envSnapshot(opts.envKeys, secretKeys, env),
        config: await configSnapshot(opts.config, clean),
        host: { platform: process.platform, bun: typeof Bun !== 'undefined' ? Bun.version : undefined, cwd: safeCwd() },
      };
      result = { id, correlationId, status: finalStatus };
      try {
        const dir = resolve(await ensureOutputDir(), 'diagnostics');
        await mkdir(dir, { recursive: true });
        const base = `${slug(opts.activity)}-${stamp(startedAt)}-${id}`;
        const logPath = resolve(dir, `${base}.log.jsonl`);
        const reportPath = resolve(dir, `${base}.report.json`);
        report.logPath = logPath;
        await Bun.write(logPath, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
        await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        result.logPath = logPath;
        result.reportPath = reportPath;
      } catch {
        // Diagnostics are best-effort — never let a write failure surface.
      }
      return result;
    },
  };
}

/**
 * Convenience wrapper: run `fn` with a session, finishing "ok" on success and
 * recording + re-throwing on failure. The one-liner the seam wrappers use.
 */
export async function withDiagnostics<T>(
  opts: DiagnosticsOptions,
  fn: (d: DiagnosticsSession) => Promise<T>,
): Promise<T> {
  const d = startDiagnostics(opts);
  try {
    const out = await fn(d);
    await d.finish();
    return out;
  } catch (err) {
    d.fail(err);
    await d.finish('error');
    throw err;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function envSnapshot(
  extraKeys: string[] | undefined,
  secretKeys: string[],
  env: Record<string, string>,
): Record<string, string> {
  const snap: Record<string, string> = {};
  for (const k of [...ENV_SNAPSHOT_KEYS, ...(extraKeys ?? [])]) {
    if (process.env[k] !== undefined) snap[k] = process.env[k] as string;
  }
  // Secret keys: presence only, never the value.
  for (const k of secretKeys) snap[k] = env[k] ? '(set)' : '(unset)';
  return snap;
}

async function configSnapshot(provided: unknown, clean: (d: unknown) => unknown): Promise<unknown> {
  if (provided !== undefined) return clean(provided);
  try {
    const { loadConfig } = await import('../config');
    return clean(await loadConfig());
  } catch {
    return undefined;
  }
}

function snippet(body: unknown): string {
  const text = typeof body === 'string' ? body : safeJson(body);
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function safeCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

/** A short, filename-safe id without pulling in node-only cwip at the top level. */
function shortId(): string {
  return Math.abs(hash(`${process.pid}:${process.hrtime.bigint()}`))
    .toString(36)
    .slice(0, 8)
    .padStart(6, '0');
}

function makeCorrelationIdSafe(): string {
  return `cid_${shortId()}${shortId()}`;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'activity';
}

/** Compact, sortable, filename-safe timestamp: 2026-06-12T10-20-30-123. */
function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\..+/, (m) => `-${m.slice(1, 4)}`);
}
