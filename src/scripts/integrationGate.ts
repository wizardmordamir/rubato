#!/usr/bin/env bun
/**
 * Integration + promotion gate entrypoint (the launchd job `com.taskq.mainhealth`;
 * replaces the untracked `~/.taskq/main-health-watchdog.ts`). Mirrors how
 * `taskqDrain.ts` is the drainer's launchd entrypoint: launchd runs THIS file from
 * the repo, so the gate is version-controlled, reviewable, and testable.
 *
 *   bun run src/scripts/integrationGate.ts          # one real cycle
 *   bun run src/scripts/integrationGate.ts --dry     # decide + log, mutate nothing
 *   bun run src/scripts/integrationGate.ts --print-launchd   # emit the plist
 *
 * Cutover from the old watchdog (once this file is on each repo's `main`):
 *   bun run src/scripts/integrationGate.ts --print-launchd > ~/Library/LaunchAgents/com.taskq.mainhealth.plist
 *   launchctl unload ~/Library/LaunchAgents/com.taskq.mainhealth.plist && launchctl load -w …
 *
 * IMPORTS ARE DELIBERATELY MINIMAL — only `node:*`, the impure `gate.ts`, and the
 * zero-dependency `launchd.ts`/pure `promote.ts` (transitively). The gate must LOAD
 * and run even when the rest of rubato (or cwip) is mid-broken — that's exactly when
 * a health watchdog matters. The taskq board shells out to the CLI rather than
 * importing `cwip/taskq` for the same reason.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultGateRepos,
  enrichedPath,
  type GateRenderResult,
  type GateRepo,
  type GateSmokeResult,
  type GateSummary,
  runGate,
  taskqCliBoard,
} from '../server/taskq/gate';
import { integrationGateLaunchdPlist } from '../server/taskq/launchd';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Build the per-repo runtime boot smoke. `bootSmoke` (→ cwip/testing) is imported
 * LAZILY + guarded, memoized across repos: a mid-broken cwip/testing degrades to the
 * build-only gate (returns `null`) instead of crashing the entrypoint — the same
 * resilience the rest of this file keeps by shelling out rather than importing cwip.
 * `ru` boots from the worktree root; `ca` boots from its `server/` workspace
 * (`bun src/index.ts`), verified green in-repo by `fu-intgate-smoke-ca`. Providers have
 * no server, so they return `null` (build-only).
 */
function makeRunSmoke(onLog: (line: string) => void) {
  let mod: typeof import('../server/taskq/bootSmoke') | null | undefined;
  const load = async () => {
    if (mod !== undefined) return mod;
    try {
      mod = await import('../server/taskq/bootSmoke');
    } catch (e) {
      onLog(`[${new Date().toISOString()}] smoke: bootSmoke helper unavailable (${e}) — build-only gate`);
      mod = null;
    }
    return mod;
  };
  return async (repo: GateRepo): Promise<GateSmokeResult | null> => {
    if (repo.name !== 'ru' && repo.name !== 'ca') return null;
    const m = await load();
    if (!m) return null;
    const port = await m.pickFreePort();
    const homeDir = m.smokeHomeDir(repo.name, `${process.pid}-${port}`);
    // Per-repo boot recipe: ca boots `bun src/index.ts` from its `server/` workspace and
    // needs a longer bound (a cold multi-workspace boot); ru boots from the worktree root.
    const spec =
      repo.name === 'ca'
        ? m.caSmokeSpec({ cwd: join(repo.integ, 'server'), port, homeDir, timeoutMs: 60_000 })
        : m.rubatoSmokeSpec({ cwd: repo.integ, port, homeDir, timeoutMs: 45_000 });
    const res = await m.runBootSmoke(spec);
    return { ok: res.ok, detail: res.detail, logTail: res.logTail };
  };
}

/**
 * Build the per-repo HEADLESS RENDER smoke (anti-white-screen). `renderSmoke` (→
 * cwip/testing + a Node Playwright host) is imported LAZILY + guarded + memoized, exactly
 * like `makeRunSmoke`: a mid-broken helper / absent browser degrades to the build+boot gate
 * (returns an INCONCLUSIVE `ran:false`) rather than crashing or wrongly blocking. Which repos
 * render is CONFIG-DRIVEN now (`GateRepo.renderSmoke`), not hardcoded by name: `ru` is on; `ca`
 * flips on in `defaultGateRepos` once heal-ca-charts verifies its build+render clean (the
 * `caRenderSmokeSpec` is ready). Providers / un-flagged consumers return `null` (build+boot only).
 */
function makeRunRender(onLog: (line: string) => void) {
  let mod: typeof import('../server/taskq/renderSmoke') | null | undefined;
  const load = async () => {
    if (mod !== undefined) return mod;
    try {
      mod = await import('../server/taskq/renderSmoke');
    } catch (e) {
      onLog(`[${new Date().toISOString()}] render: renderSmoke helper unavailable (${e}) — build+boot gate`);
      mod = null;
    }
    return mod;
  };
  return async (repo: GateRepo): Promise<GateRenderResult | null> => {
    if (!repo.renderSmoke) return null; // opt-in per repo (config-driven), not by name
    const m = await load();
    if (!m) return null;
    const port = await m.pickFreePort();
    const homeDir = m.renderSmokeHomeDir(repo.name, `${process.pid}-${port}`);
    // Per-repo render recipe: ca boots its `server/` workspace against CA_DATA_DIR/PORT
    // (caRenderSmokeSpec), ru serves the built bundle from the worktree root.
    const spec =
      repo.name === 'ca'
        ? m.caRenderSmokeSpec({ cwd: join(repo.integ, 'server'), port, homeDir, timeoutMs: 60_000 })
        : m.rubatoRenderSmokeSpec({ cwd: repo.integ, port, homeDir, timeoutMs: 45_000 });
    const res = await m.runRenderSmoke(spec);
    return { ran: res.ran, ok: res.ok, detail: res.detail, logTail: res.logTail };
  };
}

async function main(): Promise<void> {
  const home = process.env.HOME ?? '';
  const path = enrichedPath(home);
  const tqHome = process.env.TASKQ_HOME?.trim() || `${home}/.taskq`;

  if (process.argv.includes('--print-launchd')) {
    process.stdout.write(
      integrationGateLaunchdPlist({
        bunPath: process.execPath,
        rubatoDir: REPO_ROOT,
        intervalSeconds: 600,
        logDir: tqHome,
        path,
        home,
      }),
    );
    return;
  }

  const gh = `${home}/code/github`;
  const dry = process.argv.includes('--dry');
  // Test/verify seams (unset in production): override the repo set + skip the kick.
  const reposJson = process.env.MAINHEALTH_REPOS_JSON;
  const repos: GateRepo[] = reposJson ? (JSON.parse(reposJson) as GateRepo[]) : defaultGateRepos(gh);
  const noKick = process.env.MAINHEALTH_NO_KICK === '1';

  const env = { ...process.env, PATH: path };
  const board = taskqCliBoard({ bun: process.execPath, taskqPath: `${gh}/cwip/src/bin/taskq.ts`, env });

  const logFile = `${tqHome}/main-health.log`;
  const onLog = (line: string) => {
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      /* log best-effort */
    }
  };
  const summary = await runGate({
    repos,
    taskqHome: tqHome,
    dry,
    board,
    selfHealCwip: !reposJson,
    cwipMain: `${gh}/cwip`,
    cwipInteg: `${gh}/cwip-integration`,
    bun: process.execPath,
    path,
    kick: () => {
      if (noKick) return;
      spawnSync('bash', ['-c', 'launchctl kickstart -k gui/$(id -u)/com.taskq.drain'], { env });
    },
    runSmoke: makeRunSmoke(onLog),
    runRender: makeRunRender(onLog),
    onLog,
  });

  if (!dry && summary.outcome === 'ran') writeStatus(tqHome, summary);
}

/** Persist the two status files the UI/readers consume (kept in the legacy shapes). */
function writeStatus(tqHome: string, s: GateSummary): void {
  // Full integration-health summary.
  writeFileSync(
    `${tqHome}/integration-health.json`,
    JSON.stringify(
      { checkedAt: s.checkedAt, systemGreen: s.systemGreen, promoted: s.promoted, repos: s.repos, kicked: s.kicked },
      null,
      2,
    ),
  );
  // Legacy main-health.json shape (status per repo) so existing UI/readers don't break.
  writeFileSync(
    `${tqHome}/main-health.json`,
    JSON.stringify({ checkedAt: s.checkedAt, status: s.mainStatus, kicked: s.kicked }, null, 2),
  );
}

if (import.meta.main) await main();
