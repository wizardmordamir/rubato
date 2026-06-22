/**
 * Promotion-gate decision logic (PURE — the impure git/build/taskq wiring lives in
 * the `~/.taskq` watchdog that imports these).
 *
 * The orchestration keeps an **always-green main**: workers churn on each repo's
 * `refactor/integration` branch (where intermediate-broken, cross-repo states are
 * tolerated), and a recurring cross-repo gate only ever advances `main` by
 * **fast-forwarding it to a verified-green integration** — so the owner's localhost,
 * which runs off main, never sees a broken build.
 *
 * A repo's integration is "promotable-green" on TWO independent signals, both of
 * which must pass: the **build** (`bun run build` of the integration worktree — the
 * type/bundler gate) AND a lightweight **runtime boot smoke** (boot the consumer's
 * server against an isolated home/port and hit `/api/health`). The smoke catches
 * runtime-only breaks a green build misses — a missing-export crash on boot, a bad
 * dynamic import — so a build that compiles but won't run can never promote `main`.
 * The smoke is per-repo OPTIONAL (a provider with no server to boot has none); see
 * `repoGreen`/`RepoState.smokeGreen` for exactly how it gates.
 *
 * This module answers, given each repo's `main`↔`integration` ancestry and whether
 * its integration build (and runtime smoke) are green, what the gate should do:
 *
 *  - **promote**  — ff `main` → `refactor/integration` (integration is ahead AND the
 *                   WHOLE system is green). This is the only path that moves main.
 *  - **catch-up** — ff `refactor/integration` → `main` (main is ahead; integration is
 *                   strictly behind it). Always safe — integration is the churn branch
 *                   and main is the trusted/green tip — and it re-syncs the two so the
 *                   next round of work builds on top of main. Never moves main.
 *  - **hold-red** — integration is ahead but NOT green (or the system isn't all-green):
 *                   do NOT promote (would risk main); a heal task fixes integration first.
 *  - **diverged** — main and integration each have unique commits: neither can ff.
 *                   Needs manual/heal reconciliation; the gate only logs it.
 *  - **none**     — already in sync (equal tips).
 *
 * Promotion is gated on the ENTIRE system being green ("the apps run together"), not
 * just the one repo — promoting one repo's main forward while a sibling's integration
 * is red could land a main that depends on an unpromoted sibling change. catch-up is
 * not system-gated: it only ever moves the (untrusted) integration branch.
 */

/**
 * How a repo's `main`/`master` tip relates to its `refactor/integration` tip.
 * - `equal`        — same commit (in sync).
 * - `main-behind`  — integration is ahead; main is an ancestor of it → promote candidate.
 * - `main-ahead`   — main is ahead; integration is an ancestor of it → catch-up candidate.
 * - `diverged`     — each has commits the other lacks → neither can fast-forward.
 */
export type Ancestry = 'equal' | 'main-behind' | 'main-ahead' | 'diverged';

/** One repo's input to the gate decision. */
export interface RepoState {
  repo: string;
  ancestry: Ancestry;
  /** Did `bun run build` on `refactor/integration` (the integration worktree) pass? */
  integrationGreen: boolean;
  /**
   * Did the RUNTIME boot smoke pass — booting the consumer's server against an
   * isolated home/port and getting a healthy `/api/health`? This is the second,
   * independent gate on top of `integrationGreen` (which is only the type/bundler
   * build): it catches breaks that COMPILE but don't RUN (a missing-export crash on
   * boot, a bad dynamic import).
   *
   * `undefined` ⇒ no smoke applies/was run for this repo (e.g. a provider with no
   * server to boot, or a repo whose integration isn't ahead so nothing was built) →
   * it never blocks. Only an explicit `false` (smoke ran and FAILED) holds promotion.
   */
  smokeGreen?: boolean;
  /**
   * Did the HEADLESS RENDER smoke pass — booting the built UI and asserting the React
   * root actually MOUNTS in a real browser with no fatal console/page errors? This is
   * the THIRD, independent gate on top of build + boot: it catches a WHITE SCREEN that
   * compiles AND boots but never renders (a React-dedupe gap → null hook dispatcher, a
   * runtime mount throw, a missing context provider).
   *
   * Same convention as `smokeGreen`: `undefined` (no render smoke applies / inconclusive —
   * no browser available) never blocks; only an explicit `false` (rendered and FAILED)
   * holds promotion.
   */
  renderGreen?: boolean;
}

/** What the gate should do for one repo this cycle. */
export type PromoteAction = 'promote' | 'catch-up' | 'hold-red' | 'diverged' | 'none';

/**
 * Is this repo's integration "promotable-green"? It must clear ALL THREE gates: the
 * build passed AND the runtime boot smoke didn't explicitly fail AND the headless render
 * smoke didn't explicitly fail. An `undefined` smoke/render (none applies/was run, or an
 * inconclusive render) does NOT block — only a `false` does. So a build that compiles but
 * crashes on boot, OR boots but white-screens, is correctly NOT green.
 */
export function repoGreen(s: Pick<RepoState, 'integrationGreen' | 'smokeGreen' | 'renderGreen'>): boolean {
  return s.integrationGreen && s.smokeGreen !== false && s.renderGreen !== false;
}

/**
 * Decide one repo's action given the per-repo ancestry/health and whether the
 * WHOLE system's integration is green (`systemGreen`). Promotion (`main-behind`)
 * is the only action gated on `systemGreen`; everything else is local + safe.
 */
export function decideRepo(s: RepoState, systemGreen: boolean): PromoteAction {
  switch (s.ancestry) {
    case 'equal':
      return 'none';
    case 'main-ahead':
      // Integration is strictly behind main → fast-forward it up. Always safe: it
      // only moves the churn branch, never main, and re-syncs the pair.
      return 'catch-up';
    case 'diverged':
      return 'diverged';
    case 'main-behind':
      // Integration is ahead. Only advance main when this repo is green (build AND
      // runtime smoke) AND the whole system is green — otherwise hold so main never
      // goes red, nor boots broken.
      return repoGreen(s) && systemGreen ? 'promote' : 'hold-red';
  }
}

/**
 * Decide the action for every repo in one shot. Promotion is gated on the WHOLE
 * system's integration being green (every repo's `integrationGreen`), so a single
 * red repo holds back ALL promotions — but per-repo catch-up/none/diverged still
 * apply (they don't touch main).
 */
export function decideSystem(repos: RepoState[]): Map<string, PromoteAction> {
  const systemGreen = repos.length > 0 && repos.every(repoGreen);
  return new Map(repos.map((r) => [r.repo, decideRepo(r, systemGreen)]));
}

/**
 * True when a repo's integration isn't promotable-green — its build failed OR its
 * runtime boot smoke failed — and so warrants a heal task.
 */
export function integrationNeedsHeal(s: Pick<RepoState, 'integrationGreen' | 'smokeGreen' | 'renderGreen'>): boolean {
  return !repoGreen(s);
}

/**
 * Why a repo isn't promotable-green, for routing/labelling a heal task, in precedence
 * order: `'build'` (failed `bun run build`) → `'smoke'` (built but won't boot) →
 * `'render'` (boots but white-screens); `null` when the repo IS green. Ancestry-driven
 * `'diverged'` is handled separately by the caller (it's not a redness).
 */
export function healReason(
  s: Pick<RepoState, 'integrationGreen' | 'smokeGreen' | 'renderGreen'>,
): 'build' | 'smoke' | 'render' | null {
  if (!s.integrationGreen) return 'build';
  if (s.smokeGreen === false) return 'smoke';
  if (s.renderGreen === false) return 'render';
  return null;
}

/** Classify ancestry from the two pairwise `git merge-base --is-ancestor` results. */
export function ancestryFrom(opts: {
  equal: boolean;
  mainIsAncestorOfIntegration: boolean;
  integrationIsAncestorOfMain: boolean;
}): Ancestry {
  if (opts.equal) return 'equal';
  if (opts.mainIsAncestorOfIntegration) return 'main-behind';
  if (opts.integrationIsAncestorOfMain) return 'main-ahead';
  return 'diverged';
}
