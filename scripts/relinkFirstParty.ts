#!/usr/bin/env bun
/**
 * relinkFirstParty — keep the first-party dep symlinks (cwip, cursedbelt) pointing
 * at the LOCAL sibling checkouts, so a first-party edit is always live and never a
 * stale registry copy.
 *
 * Why this exists. `cwip` is pinned `^2.0.1` in package.json (so rubato stays
 * publishable as a library), which means a bare `bun install` resolves the
 * *published* build and writes a real directory copy into `node_modules/cwip`,
 * silently clobbering the symlink to the local checkout — that reverts the repo to a
 * stale cwip and is what broke `main`. cursedbelt is `link:`ed, but a global
 * `bun link` only ever maps the name to ONE checkout, so it cannot tell the `main`
 * checkout apart from a `refactor/integration` worktree. This script sidesteps both
 * failure modes by writing DIRECT, variant-aware, relative symlinks itself — no
 * global link, no registry copy, so a first-party change is always live.
 *
 * Variant-aware. A checkout whose directory is `<repo>-integration` links to the
 * sibling `<dep>-integration` builds; any other checkout (the `main` checkout, a
 * feature worktree) links to the plain `<dep>` builds. The "hub" directory that
 * holds the sibling checkouts is found by walking up from this checkout, so it works
 * at any worktree depth (a nested `rubato-worktrees/<slug>` resolves the same hub).
 *
 * Wiring. Runs as `postinstall` (guards every `bun install`), as the `relink` script
 * (manual fix), and from the tail of `scripts/setup.ts` (covers `ui/` after its
 * separate install). Zero deps + best-effort: a failure warns but never fails the
 * install, so it is safe to run anywhere — including publish/CI where the siblings
 * are absent (it simply no-ops). See `docs/integration-worktrees.md`.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

// Which node_modules dirs need which first-party deps. `cwip` is consumed as a built
// package (its `dist`), so both the root and the Vite UI bundler need it resolvable.
// `cursedbelt` is consumed as SOURCE (its `source` export condition) and resolves up
// from `ui/` to the root symlink, so it is only linked at the root — adding it under
// `ui/node_modules` would break the vite dedupe that keeps cursedbelt's peers single.
const TARGETS: ReadonlyArray<{ dir: string; deps: readonly string[] }> = [
  { dir: ".", deps: ["cwip", "cursedbelt"] },
  { dir: "ui", deps: ["cwip"] },
];

const SUFFIX = basename(ROOT).endsWith("-integration") ? "-integration" : "";

/** Nearest ancestor of this checkout that actually holds a `cwip<suffix>` sibling. */
function findHub(): string {
  let dir = dirname(ROOT);
  for (;;) {
    if (existsSync(join(dir, `cwip${SUFFIX}`))) return dir;
    const up = dirname(dir);
    if (up === dir) return dirname(ROOT); // hit the filesystem root — fall back
    dir = up;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeReadlink(p: string): string | null {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}

function relink(): void {
  const hub = findHub();
  let changed = 0;
  for (const { dir, deps } of TARGETS) {
    const nm = join(ROOT, dir, "node_modules");
    // Only touch a workspace whose node_modules already exists (it has been
    // installed). The root is always handled; mkdir below covers a first run.
    if (dir !== "." && !existsSync(nm)) continue;
    for (const dep of deps) {
      const target = join(hub, `${dep}${SUFFIX}`);
      if (!existsSync(target)) continue; // sibling checkout absent (publish/CI) — skip
      const link = join(nm, dep);
      const want = relative(nm, target); // relative target keeps the link portable
      if (isSymlink(link) && safeReadlink(link) === want) continue; // already correct
      mkdirSync(nm, { recursive: true });
      // rmSync on a symlink removes the LINK, not its target; on a real copy it
      // removes the stale directory. Scope is always node_modules/<known-dep>.
      rmSync(link, { recursive: true, force: true });
      symlinkSync(want, link);
      console.log(`relink: ${join(dir === "." ? "" : `${dir}/`, "node_modules", dep)} -> ${want}`);
      changed++;
    }
  }
  if (changed === 0) console.log("relink: first-party symlinks already correct");
}

try {
  relink();
} catch (err) {
  // Best-effort: never break an install over a relink hiccup, but be loud about it.
  console.warn(
    `relink: WARNING — could not refresh first-party symlinks: ${err instanceof Error ? err.message : err}`,
  );
}
