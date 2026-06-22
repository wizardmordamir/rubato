# Integration worktrees & first-party symlinks

This repo (and its siblings) drive a multi-app refactor where individual tasks may
land **intermediate-broken** states. To keep the owner's localhost — which runs off
each repo's default branch (`main`/`master`) — **always green**, that churn happens
on a parallel `refactor/integration` branch in a dedicated worktree, and the
first-party dependencies (`cwip`, `cursedbelt`) are wired with **real symlinks** so a
change in one is always live in the others — never a stale registry copy.

## Layout

All four repos live as direct children of `~/code/github`, with the default checkout
and an `-integration` worktree side by side:

```
~/code/github/
  cwip/                       master            ← provider (consumed via dist)
  cwip-integration/           refactor/integration
  cursedbelt/                 main              ← provider (consumed via source)
  cursedbelt-integration/     refactor/integration
  cursedalchemy/  (ca)        main              ← consumer (cwip via dist)
  cursedalchemy-integration/  refactor/integration
  rubato/         (ru)        main              ← consumer (cwip dist + cursedbelt source)
  rubato-integration/         refactor/integration
```

Each worktree has its **own `node_modules`** (a git worktree does not share the
default checkout's gitignored `node_modules`). Run `bun run setup` in a fresh one.

## How first-party deps resolve

| dep | consumed as | linked where (in ru) |
| --- | --- | --- |
| `cwip` | built package (`./dist/...` exports) | `node_modules/cwip` **and** `ui/node_modules/cwip` |
| `cursedbelt` | **source** (`source` export condition → `./src`) | `node_modules/cursedbelt` only — `ui/` resolves up to it; a `ui/node_modules/cursedbelt` would break the vite peer-dedupe |

A provider's `dist` must be built for a `dist`-consumer to typecheck (`bun run build`
in `cwip*/`, `cursedbelt*/`). Source-consumed `cursedbelt` needs no build for ru.

## The symlink guard — `scripts/relinkFirstParty.ts`

`cwip` is pinned `^2.0.1` in `package.json` so rubato stays publishable, but that
means a bare **`bun install` resolves the published cwip and writes a real directory
copy** over the symlink — reverting the repo to a stale cwip. (That is the bug class
that broke `main`.) `cursedbelt` is `link:`ed, but a global `bun link` only ever maps
the name to **one** checkout, so it can't tell `main` apart from an integration
worktree.

The guard writes **direct, variant-aware, relative symlinks** itself, bypassing both
the registry copy and the global link:

- A checkout whose directory ends in `-integration` links to the sibling
  `<dep>-integration` builds; any other checkout (default, a feature worktree) links
  to the plain `<dep>` builds. So integration resolves integration, main resolves
  main — a first-party change is always live, never cross-contaminated.
- The sibling "hub" dir is found by walking up, so it works at any worktree depth
  (incl. a nested `rubato-worktrees/<slug>`).

It runs automatically as:

- **`postinstall`** — guards every `bun install` (restores the symlink bun just
  clobbered);
- the tail of **`scripts/setup.ts`** — covers `ui/`'s separate install;
- **`bun run relink`** — manual one-shot fix.

It is zero-dependency and best-effort: if a sibling is absent (publish/CI) it no-ops,
and a failure warns without failing the install. **You no longer need `bun link cwip`
after setup** — the guard does it, correctly, per variant.

## Verifying

```bash
# in any checkout — symlinks must resolve to the right variant
bun run relink
ls -l node_modules/cwip ui/node_modules/cwip node_modules/cursedbelt
bun run tsc      # root typecheck — proves cwip resolves
```

`main` resolves `../../cwip` (+ `../../../cwip` for ui); `refactor/integration`
resolves `../../cwip-integration`. The ui typecheck (`cd ui && bun run tsc`) may carry
unrelated in-flight cursedbelt-migration errors — those are *missing-member* errors
(the module resolved), not *module-not-found*, so they don't indicate a wiring break.

## The worker flow & the promotion gate

The orchestrator (`taskqDrain` → `claudeExecutor`) spawns each task agent in the repo's
main checkout, and `buildWorkerPrompt` directs the **integration flow**: a worker
branches its task worktree **from `refactor/integration`** (named `<slug>-integration`
so the symlink guard resolves the integration builds), verifies its **own** repo, and
merges **back to `refactor/integration`** — never `main`. Cross-repo or whole-system
breakage on integration is tolerated; a heal task fixes it later. `main` is never
touched by a worker.

`main` only ever advances through the **promotion gate** — the version-controlled
`src/scripts/integrationGate.ts` (launchd job `com.taskq.mainhealth`, every ~10m;
evolved from the old untracked `~/.taskq/main-health-watchdog.ts`). Each idle cycle it:

1. Classifies each repo's `main` ↔ `refactor/integration` ancestry.
2. **Builds** the integration worktrees that are ahead (providers `cwip`/`cursedbelt`
   first, so consumers `ca`/`ru` resolve their fresh integration dist — the cross-repo
   "apps run together" check). This is the TYPE/bundler gate.
2b. **Runtime boot smoke** — after a green build, boots each smoke-configured consumer
   against an **isolated state dir + a free port** and waits for a healthy `/api/health`
   (`ru` → `rubato-serve`, `RUBATO_HOME`/`RUBATO_PORT`), then tears it down. This catches
   runtime-only breaks a green build misses — a missing-export crash on boot, a bad
   dynamic import — so a build that *compiles* but *won't run* can never promote `main`.
   Bounded by a timeout and isolated, like the rest of the gate.
3. **Promotes** (`git merge --ff-only` `main` → integration) only when the **whole
   system** is green — where "green" now means BOTH the build passed AND the runtime
   smoke didn't fail — so `main` never advances to a broken-OR-unbootable state. It
   **catches up** the reverse (ff integration → `main`) when `main` is ahead, and
   **holds** (no promote) when any repo's integration is build-red or boot-red.
4. Spawns ONE deduped **`heal-<repo>-integration`** task per red/diverged repo, on the
   integration flow, then kicks the drainer. The heal body distinguishes a build failure
   from a boot-smoke failure ("BUILDS but won't BOOT").
5. After promoting, rebuilds the providers' main `dist` and re-relinks the consumer
   main checkouts so localhost (which runs off `main`) stays current.

The gate is layered for review + test:

- **`src/server/taskq/promote.ts`** — the PURE promote/ancestry decision core
  (`decideSystem`/`decideRepo`/`ancestryFrom`, plus `repoGreen`/`healReason` for the
  runtime-smoke gate), unit-tested in `promote.test.ts`. A repo is promotable-green iff
  its build passed AND its boot smoke didn't fail (`RepoState.smokeGreen`; `undefined` =
  no smoke ran → never blocks).
- **`src/server/taskq/bootSmoke.ts`** — the impure runtime boot smoke
  (`rubatoSmokeSpec`/`planSmoke`/`runBootSmoke`), reusing cwip/testing's hardened
  spawn+health-poll. Pure plan + an impure runner that boots a consumer against an
  isolated home/port, waits for health, tears it down, and NEVER throws (a boot failure
  is `{ ok:false }` + the log tail). Unit-tested in `bootSmoke.test.ts`; a functional
  test boots the REAL `rubato-serve` through it.
- **`src/server/taskq/gate.ts`** — the IMPURE git/build/heal wiring (`runGate`). It
  imports only `node:*` + the zero-import pure core, so the gate still loads/runs when
  the rest of rubato (or cwip) is mid-broken — and shells out to the taskq CLI rather
  than importing `cwip/taskq` for the same resilience. The taskq board, launchd kick,
  logging, **and the boot smoke** are all INJECTED seams (`GateOptions.runSmoke`), so
  gate.ts never hard-imports bootSmoke (→ cwip/testing) — preserving its resilience —
  and `src/test/integration/integrationGate.int.test.ts` exercises the real
  git/build/smoke/ff/heal wiring in-process against throwaway temp repos (ported from
  the old `~/.taskq/verify-intgate.ts`).
- **`src/scripts/integrationGate.ts`** — the thin launchd entrypoint (mirrors
  `taskqDrain.ts`). It wires the real `runSmoke` via a **guarded lazy import** of
  bootSmoke (so a mid-broken cwip/testing degrades to the build-only gate instead of
  crashing the entrypoint). `--dry` decides + logs without mutating; `--print-launchd`
  emits the `com.taskq.mainhealth` plist (pointing at this repo file); the repo set +
  `TASKQ_HOME` are env-overridable (`MAINHEALTH_REPOS_JSON`/`MAINHEALTH_NO_KICK`) for an
  isolated run.

> **ca's runtime smoke is a follow-up** (`fu-intgate-smoke-ca`): its multi-workspace boot
> needs an isolated `CA_DATA_DIR` + `PORT` (and a `caSmokeSpec` mirroring `rubatoSmokeSpec`)
> verified in the ca repo first. Until then ca stays build-only (its `runSmoke` returns
> `null`) so an unverified smoke can't freeze the system-gated promotion.

**Cutover from the old untracked watchdog** (once this file is on each repo's `main`):
regenerate the plist from the repo and reload it —
`bun run src/scripts/integrationGate.ts --print-launchd > ~/Library/LaunchAgents/com.taskq.mainhealth.plist`,
then `launchctl unload … && launchctl load -w …`. The label is unchanged, so it
replaces the old job in place.

### Three green signals: build → boot → render (anti white-screen)

A repo's integration is only promotable-green when ALL of these hold — each catches a
failure the previous one can't:

1. **`bun run build`** — the bundle TYPE-checks + BUNDLES.
2. **Runtime boot smoke** (`src/server/taskq/bootSmoke.ts`) — boot the server on an
   isolated home + free port, wait for `/api/health`. Catches a build that compiles but
   crashes on boot (a missing export, a bad import at startup).
3. **Headless render smoke** (`src/server/taskq/renderSmoke.ts`) — **build the SPA**
   (`web:build`, cached — the gate's `bun run build` only builds the LIB dist, NOT the
   `ui/dist` SPA, so without this the server would serve a non-SPA fallback that reads as a
   false white screen), boot it, and drive a HEADLESS browser at it (Playwright in a `node`
   subprocess — `render-smoke-host.mjs`), asserting the **React root actually mounted**
   (non-empty) with **no fatal console errors / uncaught page exceptions**. This is the only
   signal that catches a **WHITE SCREEN**: two React copies from a `resolve.dedupe` gap (→ a
   null hook dispatcher), a runtime mount throw, or a missing context provider — all of which
   a green build + a healthy `/api/health` sail right past. Because it builds the SPA, it ALSO
   catches a UI that won't bundle (a `web:build` failure = RED), which the gate's lib-only
   `bun run build` never exercises. (This hardens against the incident where ru white-screened
   with `tsc` passing.)

Each smoke is folded into the repo's green signal at the wiring layer (`integrationGreen
&& smokeGreen !== false && renderGreen !== false`): a check that **can't run** (no helper /
no browser / server didn't boot) is INCONCLUSIVE and **never blocks** (it degrades to the
signals it does have); only a check that **ran and failed** holds promotion and arms a
`heal-<repo>-integration` task (build / smoke / **render** flavoured). Both smokes are
imported **lazily + guarded** so the gate keeps running even if a helper is absent.

The per-repo `renderSmoke` (and `smoke`) configs are OPT-IN: **ru** is on; **ca** stays
build+boot-only until its render smoke is verified in-repo (`fu-intgate-smoke-ca`), so an
unverified spec can't freeze the gate. `renderSmoke.ts` ships ru/ca presets
(`rubatoRenderSmokeSpec` / `caRenderSmokeSpec`) and is fully unit-tested with injected
server + browser seams (`renderSmoke.test.ts`) — no real browser in the suite.

> **Live vs. version-controlled gate.** The runtime boot + headless render smokes currently
> live in the LIVE launchd job (`~/.taskq/main-health-watchdog.ts`); `gate.ts` (the cutover
> target) does **not** carry them yet (its `runGate` is synchronous; the smokes are async).
> **Both smokes must be ported into `gate.ts`/`integrationGate.ts` before the cutover above**,
> or the cutover would silently drop boot + render gating. `renderSmoke.ts`/`bootSmoke.ts`
> expose the injectable cores ready for that port. (Tracked as a follow-up task.)

### Per-task UI verification + the dedupe guardrail (prevention)

The promotion gate is the backstop; two earlier layers stop a white-screen from getting
that far:

- **Worker prompt** (`claudeExecutor.buildWorkerPrompt`) — a **UI-touching** task (anything
  under `ui/`, a page/component, the vite config, or a first-party dep its bundle pulls in)
  is told that `tsc` + a green build are NOT enough and must run `rubato-render-smoke`
  (`bun run src/scripts/renderSmoke.ts`) and confirm it's GREEN before marking done. The
  same `runRenderSmoke` core backs both the worker check and the gate, so they agree on
  what "renders" means. (A render auto-revert is deliberately NOT wired into the false-done
  gate — a browser flake must never revert real work; the promotion gate is the enforcer.)
- **Dedupe-completeness guardrail** (`src/lib/viteDedupe.ts` + `viteDedupe.test.ts`) — a
  pure check that an app's vite `resolve.dedupe` covers EVERY required React subpath
  (`react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, `react/jsx-dev-runtime`)
  plus recommended context libs. A missing subpath — `react/jsx-dev-runtime` especially —
  white-screens ONLY in dev (dev compiles JSX via `jsx-dev-runtime`, prod via `jsx-runtime`),
  which a prod-bundle render smoke can't see. The guardrail runs against ru's own
  `ui/vite.config.ts` as a test, so a regression fails the gate; the pure checker is
  reusable by the cross-repo anti-drift guardrails (`fu-guardrails-enforce`).
