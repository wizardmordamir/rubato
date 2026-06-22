/**
 * Integration + promotion gate — the IMPURE git/build/heal wiring (evolved from the
 * old `~/.taskq/main-health-watchdog.ts`, now version-controlled here).
 *
 * Keeps an ALWAYS-GREEN main while the multi-app refactor churns on each repo's
 * `refactor/integration` branch. Each `runGate()` cycle:
 *   0. SKIP if a worker is active (don't race a landing/promotion) or a prior run holds the lock.
 *   1. SELF-HEAL the first-party wiring (production only): rebuild a stale cwip dist
 *      (main + integration) and `bun run relink` the consumers so first-party deps stay
 *      SYMLINKS (never bun-link copies) — the stale-copy bug class that used to break main.
 *   2. For each repo, classify main↔refactor/integration ancestry, then BUILD the
 *      integration worktrees that are ahead (providers first, so consumers resolve
 *      their fresh integration dist — the cross-repo "apps run together" check).
 *   3. PROMOTE: when the WHOLE system's integration is green, fast-forward each repo's
 *      main → its (verified) integration. Catch-up the reverse (ff integration → main)
 *      when main is ahead. main NEVER advances to a red state.
 *   4. HEAL: one deduped P0 heal task per repo whose integration is RED (or diverged),
 *      ON refactor/integration — then kick the drainer.
 *   5. Return a structured summary (the entrypoint writes the log + status JSON files).
 *
 * The PURE promote/ancestry decision logic lives in (and is unit-tested in) `./promote.ts`,
 * imported here. This module imports ONLY `node:*` builtins + that zero-import pure core,
 * so the gate still LOADS and runs even when the rest of rubato (or cwip) is mid-broken —
 * the whole point of a health watchdog. The taskq board, the launchd kick, logging, and
 * status persistence are injected (see `GateOptions`), so the git/build/heal wiring is
 * exercised in-process against temp repos by `gate.int.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  type Ancestry,
  ancestryFrom,
  decideSystem,
  healReason,
  type PromoteAction,
  type RepoState,
  repoGreen,
} from './promote';

/** One repo the gate manages. */
export interface GateRepo {
  /** taskq repo alias (matches `~/.taskq/config.json` `repos` keys). */
  name: string;
  /** default-branch checkout (stays on main/master — promotion-only). */
  main: string;
  /** the permanent `refactor/integration` worktree. */
  integ: string;
  /** providers (cwip, cursedbelt) are consumed by ca/ru — build them first. */
  role: 'provider' | 'consumer';
}

/** A taskq task as the gate needs to see it (for the claimed-skip + heal dedup). */
export interface GateTask {
  id: string | number;
  slug: string;
  status: string;
}

/**
 * The taskq board seam. Production shells out to the taskq CLI (`taskqCliBoard`);
 * tests pass an in-memory fake. Kept narrow so the heal/dedup logic is exercised
 * without a real queue/DB.
 */
export interface GateBoard {
  /** Every task (used for the claimed-skip and heal-task dedup). */
  list(): GateTask[];
  /** Create a new heal task (ready, top of queue). */
  add(input: { title: string; slug: string; body: string; repo: string }): void;
  /** Update an existing task's body + append a note (re-arm path). */
  update(id: string | number, body: string, note: string): void;
  /** Move a task back to a status (re-arm a failed/parked heal). */
  setStatus(id: string | number, status: string): void;
}

/** Result of running a `git`/`sh` command. */
interface CmdResult {
  code: number;
  out: string;
  err: string;
}

/** Outcome of a consumer's RUNTIME boot smoke (the shape `GateOptions.runSmoke` returns). */
export interface GateSmokeResult {
  /** Did the server boot and answer health? */
  ok: boolean;
  /** Human-readable summary (success line, or the failure reason). */
  detail: string;
  /** Last lines of the server's output — the gold when a boot fails. */
  logTail?: string;
}

export interface GateOptions {
  /** Repos to manage, in any order (build order is derived from `role`). */
  repos: GateRepo[];
  /** Root for the lock/log/status files (default `~/.taskq`). */
  taskqHome: string;
  /** Decide-and-log only; mutate nothing (no ff/promote/task creation/kick). */
  dry: boolean;
  /** Where heal tasks are read/written. */
  board: GateBoard;
  /** Fire the launchd drainer kick when a heal task is (re)armed. No-op under dry. */
  kick: () => void;
  /**
   * INJECTED runtime boot smoke: after a green BUILD, boot the consumer's server
   * against an isolated home/port and check `/api/health` (see `bootSmoke.ts`). Called
   * for each built+green repo; return `null` for a repo with no smoke (providers, or a
   * consumer not yet smoke-enabled) so it stays build-only. Kept as a SEAM so `gate.ts`
   * never hard-imports `bootSmoke` (→ cwip/testing) — preserving its "loads even when
   * the rest of rubato is mid-broken" resilience; the entrypoint wires the real runner
   * via a guarded lazy import. Omitted entirely ⇒ build-only gate (today's behaviour).
   */
  runSmoke?: (repo: GateRepo) => Promise<GateSmokeResult | null>;
  /** Run the real-cwip dist freshness self-heal (production only; off when repos are overridden). */
  selfHealCwip: boolean;
  /** cwip main checkout + its `-integration` sibling, for the dist self-heal. */
  cwipMain?: string;
  cwipInteg?: string;
  /** Absolute `bun` path used for `bun run build`/`relink`. */
  bun: string;
  /** Enriched PATH for spawned tools (launchd's env is minimal — must reach bun/node/git). */
  path: string;
  /** Sink for each human log line (production appends to the log file; tests collect). */
  onLog?: (line: string) => void;
}

/** Per-repo outcome for the summary. */
export interface GateRepoResult {
  ancestry: Ancestry;
  action: PromoteAction;
  built: boolean;
  integrationGreen: boolean;
  /** Whether the runtime boot smoke ran this cycle (vs. not applicable/skipped). */
  smoked: boolean;
  /** The boot-smoke result (undefined = not run; true/false = passed/failed). */
  smokeGreen?: boolean;
}

export type GateOutcome = 'ran' | 'skipped-worker-active' | 'skipped-locked';

/** The structured result of one cycle — the entrypoint persists this to JSON. */
export interface GateSummary {
  checkedAt: string;
  outcome: GateOutcome;
  systemGreen: boolean;
  promoted: string[];
  kicked: boolean;
  repos: Record<string, GateRepoResult>;
  /** Legacy per-repo main status (kept so existing UI/readers don't break). */
  mainStatus: Record<string, string>;
}

const LOCK_STALE_MS = 25 * 60 * 1000;

/** Build the enriched PATH so launchd's minimal env can still reach bun/node/git. */
export function enrichedPath(home: string, current = process.env.PATH ?? ''): string {
  return [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    current,
  ].join(':');
}

/** The default four-repo set (cwip/cursedbelt providers → ca/ru consumers). */
export function defaultGateRepos(gh: string): GateRepo[] {
  return [
    { name: 'cwip', main: `${gh}/cwip`, integ: `${gh}/cwip-integration`, role: 'provider' },
    { name: 'cursedbelt', main: `${gh}/cursedbelt`, integ: `${gh}/cursedbelt-integration`, role: 'provider' },
    { name: 'ca', main: `${gh}/cursedalchemy`, integ: `${gh}/cursedalchemy-integration`, role: 'consumer' },
    { name: 'ru', main: `${gh}/rubato`, integ: `${gh}/rubato-integration`, role: 'consumer' },
  ];
}

/**
 * A `GateBoard` backed by the cwip taskq CLI (`bun run <taskq.ts> …`). Shelling out
 * (rather than importing `cwip/taskq`) is deliberate: it keeps the gate resilient to a
 * mid-broken cwip — exactly when the watchdog most needs to run.
 */
export function taskqCliBoard(deps: { bun: string; taskqPath: string; env: NodeJS.ProcessEnv }): GateBoard {
  const sh = (cmd: string): CmdResult => {
    const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: deps.env });
    return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || ''), err: r.stderr || '' };
  };
  const TQ = `${deps.bun} run ${deps.taskqPath}`;
  return {
    list() {
      const out = sh(`${TQ} ls --json`).out.trim();
      try {
        return JSON.parse(out || '[]') as GateTask[];
      } catch {
        // Tolerant fallback: extract the outermost JSON array if anything wrapped it.
        const i = out.indexOf('[');
        const j = out.lastIndexOf(']');
        if (i >= 0 && j > i) {
          try {
            return JSON.parse(out.slice(i, j + 1)) as GateTask[];
          } catch {
            /* fall through */
          }
        }
        return [];
      }
    },
    add(input) {
      sh(
        `${TQ} add ${JSON.stringify(input.title)} --slug ${input.slug} --body ${JSON.stringify(input.body)} --repo ${input.repo} --model opus --think high --status ready --pos top`,
      );
    },
    update(id, body, note) {
      sh(`${TQ} update ${id} --body ${JSON.stringify(body)} --note ${JSON.stringify(note)}`);
    },
    setStatus(id, status) {
      sh(`${TQ} status ${id} ${status}`);
    },
  };
}

interface RepoFacts extends RepoState {
  mainSha: string;
  intSha: string;
  built: boolean;
  buildTail?: string;
  /** Whether the runtime boot smoke ran this cycle. */
  smoked: boolean;
  /** Last lines of the smoked server's output (the gold when a boot fails). */
  smokeTail?: string;
}

/**
 * Run ONE gate cycle. Returns a structured summary; performs the real git/build/ff
 * side effects against `opts.repos` unless `opts.dry`. The lock, log, status JSON,
 * launchd kick, taskq board, and runtime boot smoke are all injected so this is fully
 * driveable in a test. Async because the boot smoke (`opts.runSmoke`) is async.
 */
export async function runGate(opts: GateOptions): Promise<GateSummary> {
  const { repos, board, dry } = opts;
  const ts = () => new Date().toISOString();
  const log = (m: string) => opts.onLog?.(`[${ts()}]${dry ? ' [dry]' : ''} ${m}`);
  const env = { ...process.env, PATH: opts.path };

  // NON-login shell (`bash -c`): a login shell would source rc files whose stray
  // output could corrupt captured stdout (git SHA reads / JSON parses).
  const sh = (cmd: string, cwd?: string): CmdResult => {
    const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
    return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || ''), err: r.stderr || '' };
  };
  // Direct git spawn (no shell) for plumbing — clean stdout, exit code is truth.
  const git = (args: string[], cwd: string): CmdResult => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env });
    return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const gitOk = (args: string[], cwd: string) => git(args, cwd).code === 0;
  const rev = (ref: string, cwd: string) => git(['rev-parse', ref], cwd).out;
  const build = (cwd: string) => sh(`${opts.bun} run build`, cwd);

  const emptySummary = (outcome: GateOutcome): GateSummary => ({
    checkedAt: ts(),
    outcome,
    systemGreen: false,
    promoted: [],
    kicked: false,
    repos: {},
    mainStatus: {},
  });

  // ── 0. skip if a worker is active (a real ff/promote must never race a landing).
  // --dry mutates nothing, so it may run alongside workers for inspection.
  if (!dry && board.list().some((t) => t.status === 'claimed')) {
    log('skip: task(s) claimed (worker active)');
    return emptySummary('skipped-worker-active');
  }

  // lock so a slow build check never overlaps a prior run (stale-recovers after 25m)
  const lockPath = `${opts.taskqHome}/.mainhealth.lock`;
  if (!dry) {
    if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs < LOCK_STALE_MS) {
      log('skip: prior health run in progress');
      return emptySummary('skipped-locked');
    }
    writeFileSync(lockPath, ts());
  }

  try {
    return await cycle();
  } finally {
    if (!dry) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* lock already gone */
      }
    }
  }

  async function cycle(): Promise<GateSummary> {
    // ── 1. self-heal: cwip dist freshness + first-party symlink drift (production only).
    if (opts.selfHealCwip && !dry) {
      const rebuildIfStale = (dir: string | undefined, label: string) => {
        if (!dir || !existsSync(dir)) return;
        const stale = sh(`find ${dir}/src -name '*.ts' -newer ${dir}/dist/index.js 2>/dev/null | head -1`).out.trim();
        if (stale || !existsSync(`${dir}/dist/index.js`)) {
          log(`${label}: cwip dist stale → rebuilding`);
          build(dir);
        }
      };
      rebuildIfStale(opts.cwipMain, 'cwip(main)');
      rebuildIfStale(opts.cwipInteg, 'cwip(integration)');
    }
    // Re-relink consumer + cursedbelt checkouts (idempotent) so first-party deps stay symlinks.
    if (!dry) {
      for (const r of repos.filter((x) => x.role === 'consumer' || x.name === 'cursedbelt')) {
        for (const dir of [r.main, r.integ]) {
          if (existsSync(`${dir}/scripts/relinkFirstParty.ts`)) sh(`${opts.bun} run relink`, dir);
        }
      }
    }

    // ── 2. classify ancestry + build the integration worktrees that are ahead ──
    const classify = (r: GateRepo): { ancestry: Ancestry; mainSha: string; intSha: string } => {
      // The main checkout knows both refs (branches are shared across a repo's worktrees).
      const mainSha = rev('HEAD', r.main);
      const intSha = rev('refactor/integration', r.main);
      const equal = !!mainSha && mainSha === intSha;
      return {
        ancestry: ancestryFrom({
          equal,
          mainIsAncestorOfIntegration: gitOk(['merge-base', '--is-ancestor', mainSha, intSha], r.main),
          integrationIsAncestorOfMain: gitOk(['merge-base', '--is-ancestor', intSha, mainSha], r.main),
        }),
        mainSha,
        intSha,
      };
    };

    const facts: RepoFacts[] = repos.map((r) => {
      const c = classify(r);
      // Default green=true for repos whose integration is NOT ahead (equal / main-ahead):
      // their integration is == or strictly behind a trusted main, so it never blocks a
      // promotion and needs no build. Only main-behind/diverged integrations get built.
      return {
        repo: r.name,
        ancestry: c.ancestry,
        integrationGreen: true,
        mainSha: c.mainSha,
        intSha: c.intSha,
        built: false,
        smoked: false,
      };
    });
    const factOf = (name: string) => facts.find((f) => f.repo === name)!;
    const repoOf = (name: string) => repos.find((r) => r.name === name)!;

    // Which integrations need building? Those AHEAD (unique commits gate promotion):
    // `main-behind` (integration ahead) or `diverged`.
    const aheadNames = facts
      .filter((f) => f.ancestry === 'main-behind' || f.ancestry === 'diverged')
      .map((f) => f.repo);
    const consumersAhead = aheadNames.filter((n) => repoOf(n).role === 'consumer');
    const toBuild = new Set(aheadNames);
    // A consumer build resolves its providers' INTEGRATION dist via symlink, so refresh
    // the providers' integration build first whenever any consumer is ahead.
    if (consumersAhead.length > 0) for (const p of repos.filter((r) => r.role === 'provider')) toBuild.add(p.name);

    // Build in dependency order: providers (cwip, cursedbelt) before consumers (ca, ru).
    for (const r of repos) {
      if (!toBuild.has(r.name)) continue;
      if (!existsSync(r.integ)) {
        log(`${r.name}: integration worktree missing (${r.integ}) — skipping build`);
        continue;
      }
      const f = factOf(r.name);
      if (dry) {
        log(`${r.name}: [dry] would build refactor/integration (${f.ancestry})`);
        f.built = true;
        continue;
      }
      const res = build(r.integ);
      f.built = true;
      f.integrationGreen = res.code === 0;
      f.buildTail = res.out
        .split('\n')
        .filter((l) => l.trim())
        .slice(-25)
        .join('\n');
      log(`${r.name}: integration build ${f.integrationGreen ? 'GREEN' : 'RED'} (${f.ancestry})`);
    }

    // ── 2b. RUNTIME boot smoke — the cross-repo "apps run together" RUNTIME check.
    // After a green BUILD, boot each smoke-configured consumer (isolated home/port) and
    // wait for /api/health, catching builds that COMPILE but won't RUN. The runner is an
    // injected seam (so gate.ts never imports cwip/testing); it returns null for a repo
    // with no smoke (providers / not-yet-enabled consumers), leaving it build-only.
    if (opts.runSmoke) {
      for (const r of repos) {
        const f = factOf(r.name);
        if (!f.built || !f.integrationGreen) continue; // only smoke a freshly-built, green integration
        if (dry) {
          // Dry skips the actual boot (it would spawn a real server), so we can't know
          // here whether this repo even has a smoke — `runSmoke` is the source of truth.
          log(`${r.name}: [dry] would runtime boot-smoke (if smoke-configured)`);
          f.smoked = true;
          continue;
        }
        const result = await opts.runSmoke(r);
        if (!result) continue; // no smoke configured for this repo → stays build-only
        f.smoked = true;
        f.smokeGreen = result.ok;
        f.smokeTail = result.logTail;
        log(`${r.name}: runtime boot smoke ${result.ok ? 'GREEN' : 'RED'} — ${result.detail}`);
      }
    }

    // ── 3. decide + (4) promote / catch-up / heal ───────────────────────────
    // Fold the smoke INTO the green signal the decision core consumes: a repo that
    // BUILDS but fails its boot smoke is not promotable-green (`repoGreen`), so it holds
    // promotion + earns a heal task, exactly like a build failure.
    const actions = decideSystem(
      facts.map((f) => ({
        repo: f.repo,
        ancestry: f.ancestry,
        integrationGreen: f.integrationGreen,
        smokeGreen: f.smokeGreen,
      })),
    );
    const systemGreen = facts.every(repoGreen);
    const promoted: string[] = [];
    let kicked = false;

    const ensureHealTask = (r: GateRepo, kind: 'build' | 'smoke' | 'diverged', tail: string): boolean => {
      const slug = `heal-${r.name}-integration`;
      const intro =
        kind === 'build'
          ? `P0 — refactor/integration is RED on ${r.name}: \`bun run build\` fails, so the promotion gate cannot advance main. Fix it ON refactor/integration.`
          : kind === 'smoke'
            ? `P0 — refactor/integration BUILDS but won't BOOT on ${r.name}: \`bun run build\` passes yet the runtime boot smoke (boot the server on an isolated home/port, hit /api/health) FAILS — a missing-export crash or a bad import at startup. The gate cannot advance main. Fix it ON refactor/integration; confirm the server actually boots + answers /api/health.`
            : `P0 — ${r.name} main and refactor/integration have DIVERGED (neither fast-forwards). Reconcile them on refactor/integration (merge main into refactor/integration, resolve, verify) so the gate can promote again.`;
      const tailLabel = kind === 'smoke' ? 'Recent server boot output' : 'Recent build output';
      const body =
        `${intro}\n` +
        `WORKFLOW: branch a worktree FROM refactor/integration (name it <slug>-integration), fix, verify THIS repo builds (\`bun run build\`), then merge back to refactor/integration — NEVER main. main is promotion-only; the gate fast-forwards it once the whole system is green.\n` +
        `FIRST in a fresh worktree: \`bun run setup\` (or \`bun i\`) then \`bun run relink\` — first-party deps (cwip/cursedbelt) are SYMLINKED, never bun-link-copied; do not "fix" a missing export by downgrading code.\n` +
        `${tailLabel}:\n${tail || '(none)'}`;
      const existing = board.list().find((t) => t.slug === slug);
      if (dry) {
        log(`${r.name}: [dry] would ${existing ? 're-arm' : 'create'} heal task ${slug} (${kind})`);
        return true;
      }
      if (!existing) {
        board.add({ title: `${r.name} integration broken — heal`, slug, body, repo: r.name });
        log(`${r.name}: created heal task ${slug} (${kind})`);
        return true;
      }
      if (['ready', 'claimed'].includes(existing.status)) {
        log(`${r.name}: heal task ${slug} already ${existing.status} — not duplicating`);
        return false;
      }
      // failed/on_hold/not_ready/blocked/done → re-arm the SAME task (crash-loop-safe).
      board.update(existing.id, body, `re-detected @ ${ts()}`);
      board.setStatus(existing.id, 'ready');
      log(`${r.name}: re-armed heal task ${slug} (was ${existing.status})`);
      return true;
    };

    for (const r of repos) {
      const f = factOf(r.name);
      const action: PromoteAction = actions.get(r.name) ?? 'none';
      switch (action) {
        case 'none':
          break;
        case 'catch-up': {
          // ff integration → main: integration is strictly behind a trusted main. Safe
          // always (only moves the churn branch); re-syncs the pair for the next round.
          if (dry) {
            log(`${r.name}: [dry] would catch-up refactor/integration → main (${f.mainSha.slice(0, 8)})`);
            break;
          }
          const res = git(['merge', '--ff-only', f.mainSha], r.integ);
          log(`${r.name}: catch-up ff integration → main ${res.code === 0 ? 'ok' : `FAILED: ${res.err.slice(-200)}`}`);
          break;
        }
        case 'promote': {
          // ff main → integration: integration is ahead AND the WHOLE system is green.
          // The ONLY path that moves main, and only to a verified-green commit.
          if (dry) {
            log(`${r.name}: [dry] would PROMOTE main → refactor/integration (${f.intSha.slice(0, 8)}) [system green]`);
            promoted.push(r.name);
            break;
          }
          const res = git(['merge', '--ff-only', f.intSha], r.main);
          if (res.code === 0) {
            promoted.push(r.name);
            log(`${r.name}: PROMOTED main → refactor/integration (${f.intSha.slice(0, 8)})`);
          } else {
            log(`${r.name}: promote ff FAILED (raced?): ${res.err.slice(-200)}`);
          }
          break;
        }
        case 'hold-red': {
          const reason = healReason(f); // 'build' | 'smoke' | null
          const why =
            reason === 'build'
              ? 'this repo build RED'
              : reason === 'smoke'
                ? 'this repo boot-smoke RED'
                : 'system not all-green';
          log(`${r.name}: integration ahead but held (${why}) — main stays put`);
          // Only the repo that's actually broken (build or smoke) gets a heal task; a repo
          // held merely because a SIBLING is red (reason === null) just waits.
          if (reason === 'build') kicked = ensureHealTask(r, 'build', f.buildTail ?? '') || kicked;
          else if (reason === 'smoke') kicked = ensureHealTask(r, 'smoke', f.smokeTail ?? '') || kicked;
          break;
        }
        case 'diverged':
          log(`${r.name}: main/integration DIVERGED — needs reconcile`);
          kicked = ensureHealTask(r, 'diverged', f.buildTail ?? '') || kicked;
          break;
      }
    }

    // ── post-promote: refresh main checkouts so localhost's first-party deps are current.
    if (!dry && promoted.length > 0) {
      // Providers' main dist must be rebuilt so main consumers see the promoted build.
      for (const p of repos.filter((r) => r.role === 'provider')) {
        if (promoted.includes(p.name)) {
          log(`${p.name}: rebuilding promoted main dist`);
          build(p.main);
        }
      }
      // Re-relink every consumer main checkout (idempotent) so symlinks resolve the fresh dist.
      for (const r of repos.filter((x) => x.role === 'consumer' || x.name === 'cursedbelt')) {
        if (existsSync(`${r.main}/scripts/relinkFirstParty.ts`)) sh(`${opts.bun} run relink`, r.main);
      }
      log(`promoted: ${promoted.join(', ')} — main checkouts refreshed`);
    }

    // ── 5. backstop: main is promotion-only, so it should never be red. Note any repo
    // whose main HEAD differs from a known-green integration but couldn't promote.
    const mainStatus: Record<string, string> = {};
    for (const f of facts) {
      mainStatus[f.repo] =
        f.ancestry === 'equal'
          ? 'in-sync'
          : f.ancestry === 'main-ahead'
            ? promoted.includes(f.repo)
              ? 'promoted'
              : 'integration-behind'
            : f.ancestry === 'diverged'
              ? 'diverged'
              : promoted.includes(f.repo)
                ? 'promoted'
                : f.integrationGreen
                  ? f.smokeGreen === false
                    ? 'integration-boot-red'
                    : 'promotable'
                  : 'integration-red';
    }

    // ── kick the drainer if a heal task was (re)armed ──
    if (!dry && kicked) opts.kick();

    log(`cycle done: systemGreen=${systemGreen} promoted=[${promoted.join(',')}] ${JSON.stringify(mainStatus)}`);

    return {
      checkedAt: ts(),
      outcome: 'ran',
      systemGreen,
      promoted,
      kicked,
      repos: Object.fromEntries(
        facts.map((f) => [
          f.repo,
          {
            ancestry: f.ancestry,
            action: actions.get(f.repo) ?? 'none',
            built: f.built,
            integrationGreen: f.integrationGreen,
            smoked: f.smoked,
            smokeGreen: f.smokeGreen,
          },
        ]),
      ),
      mainStatus,
    };
  }
}
