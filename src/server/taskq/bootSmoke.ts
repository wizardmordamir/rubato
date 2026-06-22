/**
 * Runtime boot smoke for the promotion gate (the impure companion to the pure
 * `promote.ts` decision core).
 *
 * The cross-repo gate's `bun run build` proves each integration worktree TYPE-checks
 * and BUNDLES — but a green build can still fail at RUNTIME: a module that throws on
 * import, a missing export that only blows up when the server actually boots, a bad
 * dynamic import. This module adds the second, independent signal `promote.ts` wants:
 * boot a consumer's server against an ISOLATED state dir + a unique port, wait for it
 * to answer `/api/health`, then tear it down. Pass/fail becomes `RepoState.smokeGreen`
 * so a build that compiles but won't run can never promote `main`.
 *
 * Split, like the rest of the gate, into a PURE plan (`planSmoke`/`rubatoSmokeSpec`/
 * `smokeEnv` — fully unit-testable, no spawning) and an impure `runBootSmoke` that
 * spawns + polls. The spawn + health-poll + log-capture is delegated to cwip/testing's
 * hardened `startTestServer` (the same primitive the functional testkit uses — not a
 * per-app reimplementation), injected so unit tests drive it without a real process.
 *
 * Bounded by `timeoutMs` and side-effect-isolated (its own throwaway home dir, removed
 * after), so the watchdog can run it inline every cycle without risk — and, like the
 * rest of the gate, only when an integration is actually ahead + built green.
 */
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type StartTestServerOptions, startTestServer } from 'cwip/testing';

/** How to boot one consumer for a smoke (the resolved, ready-to-spawn plan). */
export interface SmokeSpec {
  /** taskq repo alias (`ru`, `ca`, …) — labels the result. */
  repo: string;
  /** Command + args to spawn (e.g. `['bun', 'run', 'src/scripts/serve.ts']`). */
  cmd: string[];
  /** Working dir for the spawned process — the integration worktree to boot. */
  cwd: string;
  /** Port the server binds; also builds the health URL. */
  port: number;
  /** Health endpoint path (default `/api/health`). */
  healthPath: string;
  /** Env var that relocates the app's ENTIRE state footprint (the isolation knob). */
  homeEnvVar: string;
  /** The throwaway dir that env var points at (created before boot, removed after). */
  homeDir: string;
  /** Env var that sets the listen port. */
  portEnvVar: string;
  /** Max ms to wait for the server to become healthy (the bound). */
  timeoutMs: number;
  /** Extra env merged over the isolation vars (e.g. `NODE_ENV`). */
  extraEnv?: Record<string, string>;
  /** Treat a health Response as ready (default: 2xx). */
  isHealthy?: (res: Response) => boolean | Promise<boolean>;
}

/** The outcome of one repo's boot smoke. */
export interface SmokeResult {
  repo: string;
  /** Did the server boot and answer health within the bound? */
  ok: boolean;
  /** Human-readable summary (the success line, or the failure reason). */
  detail: string;
  /** Last lines of the server's stdout/stderr — the gold when a boot fails. */
  logTail?: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Inputs the caller actually supplies; everything else is defaulted by `planSmoke`. */
export interface SmokeSpecInput {
  repo: string;
  cmd: string[];
  cwd: string;
  homeEnvVar: string;
  portEnvVar: string;
  /** Bind port — REQUIRED here (kept pure/deterministic); see `pickFreePort`. */
  port: number;
  /** Isolated home — REQUIRED here; see `smokeHomeDir`. */
  homeDir: string;
  healthPath?: string;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
  isHealthy?: (res: Response) => boolean | Promise<boolean>;
}

/** Pure: fill defaults to produce a complete, spawn-ready `SmokeSpec`. */
export function planSmoke(input: SmokeSpecInput): SmokeSpec {
  return {
    repo: input.repo,
    cmd: input.cmd,
    cwd: input.cwd,
    port: input.port,
    healthPath: input.healthPath ?? '/api/health',
    homeEnvVar: input.homeEnvVar,
    homeDir: input.homeDir,
    portEnvVar: input.portEnvVar,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    extraEnv: input.extraEnv,
    isHealthy: input.isHealthy,
  };
}

/**
 * Pure: the env the spawned server runs under — the isolation knobs (home + port)
 * plus any extras. The home var relocates ALL of the app's state to a throwaway dir,
 * so the smoke never reads or writes the real `~/.rubato` (or ca's equivalent).
 */
export function smokeEnv(spec: SmokeSpec): Record<string, string> {
  return { [spec.homeEnvVar]: spec.homeDir, [spec.portEnvVar]: String(spec.port), ...spec.extraEnv };
}

/**
 * The rubato (`ru`) preset: boot `rubato-serve` from an integration worktree, isolated
 * via `RUBATO_HOME` + `RUBATO_PORT`, health-checked at `/api/health`. The watchdog
 * passes the integration worktree dir as `cwd`, a free `port`, and a throwaway
 * `homeDir`. (ca mirrors this with its own home/port env vars + health path.)
 */
export function rubatoSmokeSpec(opts: { cwd: string; port: number; homeDir: string; timeoutMs?: number }): SmokeSpec {
  return planSmoke({
    repo: 'ru',
    // No `--hot`: a smoke wants a clean one-shot boot, not a file-watcher.
    cmd: ['bun', 'run', 'src/scripts/serve.ts'],
    cwd: opts.cwd,
    homeEnvVar: 'RUBATO_HOME',
    portEnvVar: 'RUBATO_PORT',
    port: opts.port,
    homeDir: opts.homeDir,
    healthPath: '/api/health',
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * The deterministic test env ca's server REQUIRES at boot, so its smoke boots even in a
 * fresh worktree with no `server/.env` (mirrors ca's `runFt.ts` testDefaults + ca's own
 * `caSmokeEnv` in `server/__functional_tests/bootSmoke.ts`, where it is verified against
 * the real server):
 *   - COMPANY_NAME + BASE_URL — ca's auth handler runs `ensureRequiredKeysExist` at module
 *     load and throws if either is absent (presence-only — BASE_URL is never dereferenced
 *     during a boot smoke).
 *   - JWT_SECRET — ca's jwt.ts requires one >= 32 chars; a throwaway test secret, never real.
 *   - NODE_ENV/ALLOW_FORGED_SESSIONS — the shape ca's `dev:server:testrunner` script uses.
 *   - USE_MOCK_BITCOIN_PRICE_RESPONSE — keep any crypto-price path off the network.
 */
function caSmokeEnv(port: number): Record<string, string> {
  return {
    NODE_ENV: 'development',
    ALLOW_FORGED_SESSIONS: 'true',
    USE_MOCK_BITCOIN_PRICE_RESPONSE: 'true',
    COMPANY_NAME: 'Cursed Alchemy Boot Smoke',
    BASE_URL: `http://127.0.0.1:${port}`,
    JWT_SECRET: 'ca-bootsmoke-deterministic-secret-0000000000000000000000000000',
  };
}

/**
 * The cursedalchemy (`ca`) preset: boot ca's server (`bun src/index.ts`) from the
 * integration worktree's `server/` workspace, isolated via `CA_DATA_DIR` + `PORT`,
 * health-checked at `/api/health`. The caller passes the worktree's `server/` dir as
 * `cwd` (e.g. `join(repo.integ, 'server')`), a free `port`, and a throwaway `homeDir`.
 *
 * This is ca's boot recipe held gate-side; ca's repo carries the canonical, real-server-
 * verified copy (`server/__functional_tests/bootSmoke.ts` `caSmokeSpec`) — keep the two in
 * sync. (A future cleanup could lift the shared machinery into `cwip/testing`.)
 */
export function caSmokeSpec(opts: { cwd: string; port: number; homeDir: string; timeoutMs?: number }): SmokeSpec {
  return planSmoke({
    repo: 'ca',
    cmd: ['bun', 'src/index.ts'],
    cwd: opts.cwd,
    homeEnvVar: 'CA_DATA_DIR',
    portEnvVar: 'PORT',
    port: opts.port,
    homeDir: opts.homeDir,
    healthPath: '/api/health',
    timeoutMs: opts.timeoutMs,
    extraEnv: caSmokeEnv(opts.port),
  });
}

/** Injectable seams so `runBootSmoke` is unit-testable without a real process/fs. */
export interface SmokeDeps {
  startServer?: (opts: StartTestServerOptions) => Promise<{
    logs(): string[];
    stop(): Promise<void>;
  }>;
  ensureDir?: (dir: string) => Promise<void>;
  removeDir?: (dir: string) => Promise<void>;
  now?: () => number;
}

/**
 * Boot the server described by `spec`, wait for it to answer health (bounded by
 * `spec.timeoutMs`), then tear it down — returning a structured pass/fail. NEVER
 * throws: a boot failure (server crashed / never became healthy / spawn error) is
 * reported as `{ ok: false }` with the captured log tail, because the gate treats a
 * smoke that can't run as a RED signal, not a crash. Always removes the throwaway
 * home dir, even on failure.
 */
export async function runBootSmoke(spec: SmokeSpec, deps: SmokeDeps = {}): Promise<SmokeResult> {
  const startServer = deps.startServer ?? startTestServer;
  const ensureDir = deps.ensureDir ?? ((dir: string) => mkdir(dir, { recursive: true }).then(() => undefined));
  const removeDir = deps.removeDir ?? ((dir: string) => rm(dir, { recursive: true, force: true }));
  const now = deps.now ?? (() => Date.now());

  const started = now();
  const elapsed = () => now() - started;

  try {
    await ensureDir(spec.homeDir);
  } catch (e) {
    // Can't even prep the isolation dir → can't trust the smoke → RED.
    return {
      repo: spec.repo,
      ok: false,
      detail: `failed to create isolated home: ${errMsg(e)}`,
      durationMs: elapsed(),
    };
  }

  let server: { logs(): string[]; stop(): Promise<void> } | undefined;
  try {
    server = await startServer({
      cmd: spec.cmd,
      cwd: spec.cwd,
      port: spec.port,
      env: smokeEnv(spec),
      healthPath: spec.healthPath,
      timeoutMs: spec.timeoutMs,
      isHealthy: spec.isHealthy,
    });
    return {
      repo: spec.repo,
      ok: true,
      detail: `booted + healthy at ${spec.healthPath} (port ${spec.port})`,
      logTail: tailLines(server.logs()),
      durationMs: elapsed(),
    };
  } catch (e) {
    // startTestServer throws with the captured server logs in the message on a
    // never-healthy boot — surface it so a heal task knows WHY.
    return {
      repo: spec.repo,
      ok: false,
      detail: `boot smoke failed: ${errMsg(e)}`,
      logTail: server ? tailLines(server.logs()) : undefined,
      durationMs: elapsed(),
    };
  } finally {
    try {
      await server?.stop();
    } catch {
      /* best-effort */
    }
    try {
      await removeDir(spec.homeDir);
    } catch {
      /* best-effort */
    }
  }
}

/** A throwaway, per-run isolated home dir for a repo's smoke (under the OS tmpdir). */
export function smokeHomeDir(repo: string, seed: string | number = process.pid): string {
  return join(tmpdir(), `intgate-smoke-${repo}-${seed}`);
}

/**
 * Ask the OS for a free ephemeral TCP port (bind :0, read the assigned port, close).
 * There's an inherent tiny race between close and the server's bind, but for a local
 * smoke that's acceptable — far better than a hardcoded port that collides with a
 * running app or a sibling repo's smoke.
 */
export async function pickFreePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not pick a free port'))));
    });
  });
}

function tailLines(lines: string[], n = 25): string {
  return lines
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
