/**
 * Runtime boot smoke for the promotion gate — app-specific presets for rubato and ca.
 *
 * The generic boot-smoke machinery (planSmoke, runBootSmoke, smokeEnv, smokeHomeDir,
 * pickFreePort, and the shared interfaces) now lives in `cwip/testing`; only the
 * app-specific configs (boot commands, env var names, ca's required env defaults)
 * live here.
 *
 * The gate uses both presets: `rubatoSmokeSpec` for rubato's own server and
 * `caSmokeSpec`/`caSmokeEnv` for ca's server (the gate can't import across repos
 * at runtime, so ca's recipe is mirrored here too — keep it in sync with ca's
 * canonical `server/__functional_tests/bootSmoke.ts`).
 *
 * Re-exports the shared machinery so existing `from './bootSmoke'` call-sites (the
 * unit tests, integrationGate.ts, etc.) keep resolving without changes.
 */

// Import for use in the app-specific factory functions below (aliased to avoid a
// duplicate-binding conflict with the re-export below).
import { planSmoke as _planSmoke } from 'cwip/testing';
import type { SmokeSpec } from 'cwip/testing';

// Re-export the shared machinery so existing call-sites keep resolving.
export { pickFreePort, planSmoke, runBootSmoke, smokeEnv, smokeHomeDir } from 'cwip/testing';
export type { SmokeDeps, SmokeResult, SmokeSpec, SmokeSpecInput } from 'cwip/testing';

/**
 * The rubato (`ru`) preset: boot `rubato-serve` from an integration worktree, isolated
 * via `RUBATO_HOME` + `RUBATO_PORT`, health-checked at `/api/health`. The watchdog
 * passes the integration worktree dir as `cwd`, a free `port`, and a throwaway
 * `homeDir`. (ca mirrors this with its own home/port env vars + health path.)
 */
export function rubatoSmokeSpec(opts: { cwd: string; port: number; homeDir: string; timeoutMs?: number }): SmokeSpec {
  return _planSmoke({
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
 * verified copy (`server/__functional_tests/bootSmoke.ts` `caSmokeSpec`) — keep the two
 * in sync.
 */
export function caSmokeSpec(opts: { cwd: string; port: number; homeDir: string; timeoutMs?: number }): SmokeSpec {
  return _planSmoke({
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
