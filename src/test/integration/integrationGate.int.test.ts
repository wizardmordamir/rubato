/**
 * Integration: the promotion gate's IMPURE git/build/heal wiring (`runGate` from
 * `src/server/taskq/gate.ts`), driven IN-PROCESS against throwaway temp git repos
 * with an in-memory taskq board. Ports the old `~/.taskq/verify-intgate.ts` fixture
 * into the testkit so the gate is reviewable + regression-tested.
 *
 * Real `git` + real `bun run build` run against the temp repos (build = green unless
 * a committed `BROKEN` file is present); only the taskq board, the launchd kick, and
 * logging are injected. Covers:
 *  A. PROMOTE        — green system, a consumer integration ahead → main fast-forwarded.
 *  B. SYSTEM-GATING  — one repo's integration RED → NO promotion anywhere.
 *  C. HEAL + DEDUP   — the red integration spawns one deduped heal-<repo>-integration task.
 *  D. RECOVERY       — repair the red integration → the whole system promotes.
 *  E. CATCH-UP       — main ahead of integration → integration fast-forwarded up to main.
 *  F. SMOKE-GATING   — integration BUILDS green but the runtime boot smoke FAILS → NOT
 *                      promoted + a smoke-flavoured heal task (the boot-smoke gate).
 *  G. SMOKE-RECOVERY — repair the boot → smoke green → promoted.
 *
 * The boot smoke is injected (`runSmoke`); here it's a fast fake gated on a committed
 * `BOOT_BROKEN` marker (the REAL boot of `rubato-serve` is covered by
 * `src/test/functional/bootSmoke.func.test.ts`). This test proves the gate WIRING —
 * that `runGate` folds the smoke result into the promote/heal decision.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GateBoard,
  type GateRenderResult,
  type GateRepo,
  type GateSmokeResult,
  type GateTask,
  runGate,
} from '../../server/taskq/gate';

let ROOT: string;
let TASKQ_HOME: string;

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const rev = (ref: string, cwd: string) => git(['rev-parse', '--short', ref], cwd).trim();

/** A green-by-default repo: build fails only when a committed `BROKEN` file exists. */
function makeRepo(name: string): { main: string; integ: string } {
  const main = join(ROOT, name);
  const integ = join(ROOT, `${name}-integration`);
  mkdirSync(main, { recursive: true });
  git(['init', '-q', '-b', 'main'], main);
  git(['config', 'user.email', 't@t'], main);
  git(['config', 'user.name', 'test'], main);
  git(['config', 'commit.gpgsign', 'false'], main);
  writeFileSync(`${main}/package.json`, JSON.stringify({ name, scripts: { build: 'test ! -f BROKEN' } }, null, 2));
  writeFileSync(`${main}/file.txt`, 'v1\n');
  git(['add', '-A'], main);
  git(['commit', '-qm', 'init'], main);
  git(['branch', 'refactor/integration'], main);
  git(['worktree', 'add', '-q', integ, 'refactor/integration'], main);
  return { main, integ };
}

/** Commit on a worktree's checked-out branch (advances that branch). */
function commitOn(dir: string, file: string, content: string, msg: string) {
  writeFileSync(`${dir}/${file}`, content);
  git(['add', '-A'], dir);
  git(['commit', '-qm', msg], dir);
}

/** An in-memory taskq board recording the heal tasks the gate creates/re-arms. */
function makeBoard(): { board: GateBoard; tasks: GateTask[] } {
  const tasks: GateTask[] = [];
  let nextId = 1;
  const board: GateBoard = {
    list: () => tasks.map((t) => ({ ...t })),
    add: ({ slug }) => {
      tasks.push({ id: nextId++, slug, status: 'ready' });
    },
    update: () => {
      /* body/note are not asserted here */
    },
    setStatus: (id, status) => {
      const t = tasks.find((x) => x.id === id);
      if (t) t.status = status;
    },
  };
  return { board, tasks };
}

let fp: { main: string; integ: string };
let app: { main: string; integ: string };
let repos: GateRepo[];
let store: ReturnType<typeof makeBoard>;

const drive = (
  runSmoke?: (repo: GateRepo) => Promise<GateSmokeResult | null>,
  runRender?: (repo: GateRepo) => Promise<GateRenderResult | null>,
) =>
  runGate({
    repos,
    taskqHome: TASKQ_HOME,
    dry: false,
    board: store.board,
    kick: () => {},
    selfHealCwip: false,
    bun: process.execPath,
    path: process.env.PATH ?? '',
    runSmoke,
    runRender,
  });

const healOf = (slug: string) => store.tasks.filter((t) => t.slug === slug);

// A fast boot-smoke fake: a consumer's server "boots" unless a committed `BOOT_BROKEN`
// marker is present; providers have no server (→ null, stays build-only).
const bootSmokeFake = async (repo: GateRepo): Promise<GateSmokeResult | null> => {
  if (repo.role !== 'consumer') return null;
  const ok = !existsSync(join(repo.integ, 'BOOT_BROKEN'));
  return { ok, detail: ok ? 'booted + healthy at /api/health' : 'server exited on boot (missing export)' };
};

// A fast render-smoke fake: a consumer's UI "renders" unless a committed `RENDER_BROKEN`
// marker is present (a white screen); providers have no UI (→ null, stays build+boot only).
const renderSmokeFake = async (repo: GateRepo): Promise<GateRenderResult | null> => {
  if (repo.role !== 'consumer') return null;
  const ok = !existsSync(join(repo.integ, 'RENDER_BROKEN'));
  return { ran: true, ok, detail: ok ? 'React root mounted; no fatal errors' : 'WHITE SCREEN — React root never mounted' };
};

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'intgate-'));
  TASKQ_HOME = join(ROOT, '.taskq');
  mkdirSync(TASKQ_HOME, { recursive: true });
  fp = makeRepo('fp'); // provider
  app = makeRepo('app'); // consumer
  repos = [
    { name: 'fp', main: fp.main, integ: fp.integ, role: 'provider' },
    { name: 'app', main: app.main, integ: app.integ, role: 'consumer' },
  ];
  store = makeBoard();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// The scenarios share evolving git state, so they run as ordered steps (verify-intgate's flow).
describe('promotion gate — runGate against temp repos', () => {
  test('A. PROMOTE: a green consumer integration ahead → main fast-forwarded; no heal', async () => {
    commitOn(app.integ, 'file.txt', 'v2\n', 'feat: green change on integration');
    const appInt = rev('refactor/integration', app.main);
    const summary = await drive();
    expect(rev('main', app.main)).toBe(appInt); // app main promoted to its green integration
    expect(summary.promoted).toContain('app');
    expect(summary.systemGreen).toBe(true);
    expect(store.tasks.length).toBe(0); // nothing red → no heal task
  });

  test('B+C. a RED integration blocks promotion system-wide and spawns ONE deduped heal task', async () => {
    commitOn(app.integ, 'BROKEN', 'boom\n', 'break the integration build'); // app integration RED + ahead
    commitOn(fp.integ, 'file.txt', 'v2\n', 'feat: green provider change'); // fp integration GREEN + ahead
    const appMainBefore = rev('main', app.main);
    const fpMainBefore = rev('main', fp.main);

    const summary = await drive();
    expect(rev('main', app.main)).toBe(appMainBefore); // RED integration → app main held
    expect(rev('main', fp.main)).toBe(fpMainBefore); // system not all-green → fp held too
    expect(summary.systemGreen).toBe(false);
    expect(summary.promoted).toEqual([]);

    const heal = healOf('heal-app-integration');
    expect(heal.length).toBe(1);
    expect(['ready', 'claimed']).toContain(heal[0].status);

    await drive(); // a second cycle must NOT duplicate the heal task
    expect(healOf('heal-app-integration').length).toBe(1);
  });

  test('D. RECOVERY: repairing the red integration promotes the whole system', async () => {
    git(['rm', '-q', 'BROKEN'], app.integ);
    git(['commit', '-qm', 'fix: repair integration build'], app.integ);
    const appInt = rev('refactor/integration', app.main);
    const fpInt = rev('refactor/integration', fp.main);

    const summary = await drive();
    expect(rev('main', app.main)).toBe(appInt); // app promoted once green again
    expect(rev('main', fp.main)).toBe(fpInt); // fp promoted now the system is green
    expect(summary.systemGreen).toBe(true);
    expect(summary.promoted.sort()).toEqual(['app', 'fp']);
  });

  test('E. CATCH-UP: a commit straight on main → integration fast-forwarded up to main', async () => {
    commitOn(fp.main, 'file.txt', 'v3-main\n', 'chore: a commit on fp main ahead of integration');
    const fpMain = rev('main', fp.main);

    const summary = await drive();
    expect(rev('refactor/integration', fp.main)).toBe(fpMain); // integration caught up to main
    expect(summary.repos.fp.action).toBe('catch-up');
    expect(summary.repos.fp.ancestry).toBe('main-ahead');
  });

  test('F. SMOKE-GATING: build green but the server wont boot → held + smoke heal, NOT promoted', async () => {
    // Retire the prior (build) heal so F proves a FRESH, smoke-flavoured re-arm.
    const prior = healOf('heal-app-integration')[0];
    if (prior) store.board.setStatus(prior.id, 'done');
    commitOn(app.integ, 'file.txt', 'v4-green-build\n', 'feat: a green build on integration');
    commitOn(app.integ, 'BOOT_BROKEN', 'boom\n', 'break the RUNTIME boot (server exits on startup)');
    const appMainBefore = rev('main', app.main);

    const summary = await drive(bootSmokeFake);
    expect(rev('main', app.main)).toBe(appMainBefore); // built fine, but won't boot → NOT promoted
    expect(summary.repos.app.built).toBe(true);
    expect(summary.repos.app.integrationGreen).toBe(true); // the BUILD was green
    expect(summary.repos.app.smoked).toBe(true);
    expect(summary.repos.app.smokeGreen).toBe(false); // ...the runtime smoke was RED
    expect(summary.systemGreen).toBe(false);
    expect(summary.promoted).toEqual([]);

    const heal = healOf('heal-app-integration');
    expect(heal.length).toBe(1);
    expect(heal[0].status).toBe('ready'); // re-armed for the boot failure
  });

  test('G. SMOKE-RECOVERY: repairing the boot → smoke green → app promoted', async () => {
    git(['rm', '-q', 'BOOT_BROKEN'], app.integ);
    git(['commit', '-qm', 'fix: server boots + serves /api/health again'], app.integ);
    const appInt = rev('refactor/integration', app.main);

    const summary = await drive(bootSmokeFake);
    expect(rev('main', app.main)).toBe(appInt); // promoted once it boots + smoke is green
    expect(summary.repos.app.smokeGreen).toBe(true);
    expect(summary.promoted).toContain('app');
  });

  test('H. RENDER-GATING: build + boot green but the UI white-screens → held + render heal, NOT promoted', async () => {
    // Retire the prior heal so H proves a FRESH, render-flavoured re-arm.
    const prior = healOf('heal-app-integration')[0];
    if (prior) store.board.setStatus(prior.id, 'done');
    commitOn(app.integ, 'file.txt', 'v5-green-build-boot\n', 'feat: a green build that boots');
    commitOn(app.integ, 'RENDER_BROKEN', 'boom\n', 'break the RENDER (React root never mounts → white screen)');
    const appMainBefore = rev('main', app.main);

    const summary = await drive(bootSmokeFake, renderSmokeFake);
    expect(rev('main', app.main)).toBe(appMainBefore); // builds + boots, but white-screens → NOT promoted
    expect(summary.repos.app.built).toBe(true);
    expect(summary.repos.app.integrationGreen).toBe(true); // BUILD green
    expect(summary.repos.app.smokeGreen).toBe(true); // BOOT green
    expect(summary.repos.app.rendered).toBe(true);
    expect(summary.repos.app.renderGreen).toBe(false); // ...but the RENDER was RED (white screen)
    expect(summary.systemGreen).toBe(false);
    expect(summary.promoted).toEqual([]);

    const heal = healOf('heal-app-integration');
    expect(heal.length).toBe(1);
    expect(heal[0].status).toBe('ready'); // re-armed for the white screen
  });

  test('I. RENDER-RECOVERY: fixing the white screen → render green → app promoted', async () => {
    git(['rm', '-q', 'RENDER_BROKEN'], app.integ);
    git(['commit', '-qm', 'fix: React root mounts again'], app.integ);
    const appInt = rev('refactor/integration', app.main);

    const summary = await drive(bootSmokeFake, renderSmokeFake);
    expect(rev('main', app.main)).toBe(appInt); // promoted once build + boot + render are all green
    expect(summary.repos.app.renderGreen).toBe(true);
    expect(summary.promoted).toContain('app');
  });

  test('J. RENDER-INCONCLUSIVE: a render check that cannot run (ran:false) never blocks promotion', async () => {
    commitOn(app.integ, 'file.txt', 'v6-inconclusive\n', 'feat: another green change');
    const appInt = rev('refactor/integration', app.main);
    const inconclusiveRender = async (repo: GateRepo): Promise<GateRenderResult | null> =>
      repo.role === 'consumer' ? { ran: false, ok: false, detail: 'no browser available' } : null;

    const summary = await drive(bootSmokeFake, inconclusiveRender);
    expect(rev('main', app.main)).toBe(appInt); // inconclusive render → does NOT hold promotion
    expect(summary.repos.app.renderGreen).toBeUndefined();
    expect(summary.promoted).toContain('app');
  });
});
