/**
 * Boot the REAL `rubato-serve` in a subprocess for functional tests — the same
 * binary the e2e suite and a user run, pointed at the (already-seeded) isolated
 * RUBATO_HOME and inheriting the fake-upstream creds/config. Returns a typed
 * client (`request`) plus `stop()`. Use via `useFunctional()` in harness.ts.
 *
 * The spawn + health-poll + log-capture is cwip/testing's `startTestServer` (one
 * shared, hardened primitive instead of a per-app reimplementation); this wrapper
 * just supplies rubato's command/port/health path and keeps the existing return
 * shape (now also exposing captured server `logs()`).
 */

import { resolve } from 'node:path';
import { startTestServer as startCwipServer } from 'cwip/testing';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const SERVE = resolve(REPO_ROOT, 'src/scripts/serve.ts');

export interface TestServer {
  baseUrl: string;
  port: number;
  /** Fetch a path on the running server (path is appended to the base URL). */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Recently captured server stdout/stderr (for debugging a failure). */
  logs(): string[];
  stop(): Promise<void>;
}

export interface StartServerOptions {
  /** Port to bind (default RUBATO_TEST_PORT env or 4788). */
  port?: number;
  /** Extra env for the server process (merged over the inherited env). */
  env?: Record<string, string>;
  /** Health-check timeout (default 15s). */
  timeoutMs?: number;
}

/**
 * Start `rubato-serve` against the current `RUBATO_HOME` (seed it first). The
 * fake upstream runs in the test process; the server reaches it over loopback,
 * so its config's `<svc>.baseUrl` values just work.
 */
export async function startTestServer(opts: StartServerOptions = {}): Promise<TestServer> {
  const port = opts.port ?? Number(process.env.RUBATO_TEST_PORT ?? 4788);
  const srv = await startCwipServer({
    cmd: ['bun', 'run', SERVE],
    port,
    cwd: REPO_ROOT,
    env: { RUBATO_PORT: String(port), ...opts.env },
    healthPath: '/api/health',
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  return { baseUrl: srv.baseUrl, port: srv.port, request: srv.request, logs: srv.logs, stop: srv.stop };
}
