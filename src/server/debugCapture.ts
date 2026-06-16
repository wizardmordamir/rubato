/**
 * Debug capture: record the full request/response of outbound API calls + DB
 * queries (params/SQL) so a failure on another machine (missing key, API-version
 * drift, wrong endpoint) can be shipped back here as one sealed string and
 * inspected. OFF by default — enabled by `RUBATO_CAPTURE` env or the toggle API,
 * so it never adds overhead or stores payloads in normal use.
 *
 * Everything captured is REDACTED before it's stored: secret-looking headers are
 * masked and any ~/.rubato/.env secret value appearing in a URL/body/response is
 * scrubbed (cwip `cleanDataForLogging`, the same redactor diagnostics uses). The
 * buffer is in-memory + bounded (a ring), and exports go through the sealed-string
 * bundle transport (cwip `sealToText`).
 */

import {
  type CaptureRecord,
  type CaptureSink,
  captureFetch,
  captureQuery,
  cleanDataForLogging,
  createMemoryCaptureSink,
} from 'cwip';
import { optionalEnv, rubatoEnvMap } from '../api/env';
import { currentCorrelationId } from '../lib/correlation';

const MAX_RECORDS = 1000;
const SECRET_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|api-key)$/i;

let enabled = false;
let installed = false;
const buffer = createMemoryCaptureSink({ max: MAX_RECORDS });

/** Mask secret-looking header keys in a captured request/response shape. */
function maskHeaders(obj: unknown): void {
  if (!obj || typeof obj !== 'object') return;
  const headers = (obj as { headers?: Record<string, unknown> }).headers;
  if (headers && typeof headers === 'object') {
    for (const k of Object.keys(headers)) {
      if (SECRET_HEADER.test(k)) headers[k] = '***redacted***';
    }
  }
}

/**
 * The sink everything funnels through: mask secret headers, then run the whole
 * record through cwip's value-redactor against the live env secrets, then buffer.
 */
const redactingSink: CaptureSink = (record) => {
  maskHeaders(record.request);
  maskHeaders(record.response);
  const cleaned = cleanDataForLogging(record, rubatoEnvMap()) as CaptureRecord;
  // Tie this outbound call to the request that made it, so it can be shown
  // alongside that request's server logs (logsForCorrelation).
  const cid = currentCorrelationId();
  if (cid) cleaned.meta = { ...(cleaned.meta ?? {}), correlationId: cid };
  buffer.sink(cleaned);
};

const isTruthy = (v: string | undefined): boolean => v === '1' || v === 'true' || v === 'yes' || v === 'on';

/** Is the URL our own loopback server (skip — we capture OUTBOUND calls, not self)? */
function isLoopback(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/**
 * Wrap the global fetch ONCE so that, while capture is enabled, every outbound
 * (non-loopback) request/response is recorded. Cheap no-op while disabled.
 */
export function installFetchCapture(): void {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Pass through when off, for our own loopback, or for Request-object inputs
    // (captureFetch records string/URL calls — which is how the service clients call).
    if (!enabled || input instanceof Request) return original(input, init);
    const url = urlOf(input);
    if (isLoopback(url)) return original(input, init);
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // keep the raw url as the label
    }
    return captureFetch(input as string | URL, init ?? {}, { label: host, sink: redactingSink, fetch: original });
  }) as typeof fetch;
}

/**
 * Wrap a DB query so it's captured (SQL + params + result/error) while enabled.
 * `run` is the actual execution; returns its result unchanged.
 */
export function captureDbRun<T>(label: string, sql: string, params: unknown, run: () => Promise<T>): Promise<T> {
  if (!enabled) return Promise.resolve(run());
  return captureQuery(run, { label, sql, params, sink: redactingSink });
}

/** Initialize at server start: honor the env flag and install the fetch hook. */
export function initDebugCapture(): void {
  if (isTruthy(optionalEnv('RUBATO_CAPTURE'))) enabled = true;
  installFetchCapture();
}

export function setCaptureEnabled(on: boolean): void {
  enabled = on;
  installFetchCapture(); // make sure the hook is in place once turned on
}

export function captureRecords(): CaptureRecord[] {
  return buffer.records();
}

export function clearCapture(): void {
  buffer.clear();
}
