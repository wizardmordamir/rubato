/**
 * Debug-capture unit tests: the off-by-default gate, global-fetch + DB capture,
 * and secret-header redaction. No network or browser needed — fetch is stubbed
 * and DB runs are plain async functions.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { captureDbRun, captureRecords, clearCapture, installFetchCapture, setCaptureEnabled } from './debugCapture';

// Stub the global fetch ONLY for this file's tests (restored in afterAll), so the
// stub never leaks into the integration/functional suites that share the process.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    void init;
    return new Response(JSON.stringify({ url, ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  installFetchCapture(); // wraps the stub (original = current globalThis.fetch)
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  setCaptureEnabled(false);
  clearCapture();
});
afterEach(() => {
  setCaptureEnabled(false);
  clearCapture();
});

test('off by default: nothing is recorded while disabled', async () => {
  await captureDbRun('postgres:test', 'SELECT 1', {}, async () => [{ one: 1 }]);
  await globalThis.fetch('https://api.example.com/v1/thing');
  expect(captureRecords()).toHaveLength(0);
});

test('captures DB runs (sql + params) when enabled and returns the result unchanged', async () => {
  setCaptureEnabled(true);
  const rows = await captureDbRun('postgres:prod', 'SELECT * FROM t WHERE id = $1', [42], async () => [{ id: 42 }]);
  expect(rows).toEqual([{ id: 42 }]);
  const recs = captureRecords();
  expect(recs).toHaveLength(1);
  expect(recs[0].label).toBe('postgres:prod');
  expect(JSON.stringify(recs[0].request)).toContain('SELECT * FROM t');
});

test('captures outbound fetch with the host as label, skipping loopback', async () => {
  setCaptureEnabled(true);
  await globalThis.fetch('https://api.example.com/v1/thing');
  await globalThis.fetch('http://localhost:9999/api/self'); // loopback → skipped
  const recs = captureRecords();
  expect(recs).toHaveLength(1);
  expect(recs[0].label).toBe('api.example.com');
});

test('redacts secret-looking request/response headers', async () => {
  setCaptureEnabled(true);
  await globalThis.fetch('https://api.example.com/secure', {
    headers: { authorization: 'Bearer super-secret-token', 'x-api-key': 'abc123', accept: 'application/json' },
  });
  const blob = JSON.stringify(captureRecords());
  expect(blob).not.toContain('super-secret-token');
  expect(blob).not.toContain('abc123');
  expect(blob).toContain('***redacted***');
  expect(blob).toContain('application/json'); // non-secret header preserved
});

test('clear empties the buffer', async () => {
  setCaptureEnabled(true);
  await captureDbRun('x', 'SELECT 1', {}, async () => 1);
  expect(captureRecords()).toHaveLength(1);
  clearCapture();
  expect(captureRecords()).toHaveLength(0);
});
