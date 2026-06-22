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
