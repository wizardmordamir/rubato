#!/usr/bin/env bun
/**
 * relinkFirstParty — keep the first-party dep symlinks (cwip, cursedbelt) pointing
 * at the LOCAL sibling checkouts, AND keep a SOURCE-consumed sibling's dependency
 * closure installed, so a first-party edit is always live (never a stale registry
 * copy) and the consumer's build can resolve every transitive import.
 *
 * Why this exists.
 *
 * 1. Variant-correct symlinks. `cwip` and `cursedbelt` are both `link:`ed in
 *    package.json, so a bare `bun install` writes a symlink rather than a stale
 *    *registry* copy that would silently clobber the local checkout (the "bare `bun i`
 *    reverts cwip to the published build" hazard that broke `main`). But a global
 *    `bun link` only ever maps a name to ONE checkout, so it cannot tell the `main`
 *    checkout apart from a `refactor/integration` worktree. This script sidesteps that
 *    by writing DIRECT, variant-aware, relative symlinks itself — no reliance on the
 *    global link's single target. (Both first-party deps are `link:` because rubato
 *    consumes them locally through the multi-app refactor; it is not currently
 *    publishable as a library while a sibling dep is `link:`ed anyway.)
 *
 * 2. Source-consumed dep closures. `cursedbelt` is consumed AS SOURCE — its `source`
 *    export condition resolves to `./src/*`, and ui/vite.config + ui/tsconfig select
 *    that condition (so a one-line cursedbelt edit appears with no rebuild). The catch:
 *    when the UI bundle pulls in cursedbelt, Vite/rollup follows the symlink to
 *    cursedbelt's real path and resolves cursedbelt's ENTIRE runtime dependency
 *    closure from the cursedbelt *checkout's own* node_modules — NOT from rubato's. A
 *    `link:` (unlike a workspace) does NOT install the linked package's deps, and any
 *    dep added to cursedbelt without a reinstall leaves its node_modules incomplete →
 *    the consumer's `web:build` dies on the first unresolved import (e.g.
 *    `@hookform/resolvers/zod`). Declaring cursedbelt's whole closure on rubato instead
 *    would duplicate it and silently drift on every cursedbelt change, so we keep
 *    cursedbelt the single source of truth and just make sure its node_modules is
 *    complete — self-healing it with `bun install` when (and only when) something is
 *    actually missing. `cwip` is DIST-consumed (no `source` condition; it ships a
 *    prebuilt `dist/` with its deps bundled) and is therefore exempt.
 *
 * Variant-aware. A checkout whose directory is `<repo>-integration` links to the
 * sibling `<dep>-integration` builds; any other checkout (the `main` checkout, a
 * feature worktree) links to the plain `<dep>` builds. The "hub" directory that
 * holds the sibling checkouts is found by walking up from this checkout, so it works
 * at any worktree depth (a nested `rubato-worktrees/<slug>` resolves the same hub).
 *
 * Wiring. Runs as `postinstall` (guards every `bun install`), as the `relink` script
 * (manual fix), and from the tail of `scripts/setup.ts` (covers `ui/` after its
 * separate install) — so a fresh `bun run setup` yields a resolvable clean build.
 * Zero deps + best-effort: a failure warns but never fails the install, so it is safe
 * to run anywhere — including publish/CI where the siblings are absent (it simply
 * no-ops). See `docs/integration-worktrees.md`.
 */
import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
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

/** The variant-correct sibling checkout that `<dep>` resolves to from this checkout. */
function targetFor(hub: string, dep: string): string {
  return join(hub, `${dep}${SUFFIX}`);
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

function readJson(p: string): any | null {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function relink(hub: string): void {
  let changed = 0;
  for (const { dir, deps } of TARGETS) {
    const nm = join(ROOT, dir, "node_modules");
    // Only touch a workspace whose node_modules already exists (it has been
    // installed). The root is always handled; mkdir below covers a first run.
    if (dir !== "." && !existsSync(nm)) continue;
    for (const dep of deps) {
      const target = targetFor(hub, dep);
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

/**
 * A first-party dep is consumed AS SOURCE when its package.json `exports` declare a
 * `source` condition anywhere (cursedbelt → `./src/*`). Such a dep is bundled from its
 * own checkout, so the consumer must resolve its whole dependency closure from that
 * checkout's node_modules. cwip is dist-consumed (no `source` condition) and is exempt.
 */
function isSourceConsumed(pkg: any): boolean {
  const exp = pkg?.exports;
  if (!exp || typeof exp !== "object") return false;
  return Object.values(exp).some((e) => e && typeof e === "object" && typeof (e as any).source === "string");
}

/**
 * The deps a source-consumed sibling must carry in its OWN node_modules for a consumer
 * source build to resolve every import: its `dependencies`, plus the `peerDependencies`
 * it SELF-PROVIDES (i.e. also lists in `devDependencies` — cursedbelt's optional feature
 * peers like @vidstack/react / mediabunny / react-photo-album live there). A `bun install`
 * (dev mode) installs both sets, so re-checking after an install always passes — the
 * heal can never loop. Peers it does NOT self-provide (react / react-dom) are the
 * consumer's job (Vite `resolve.dedupe` forces a single copy from the consumer), so they
 * are deliberately excluded — checking them could otherwise trigger a no-op reinstall.
 */
function requiredDeps(pkg: any): string[] {
  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));
  const selfProvidedPeers = Object.keys(pkg.peerDependencies ?? {}).filter((p) => devDeps.has(p));
  return [...new Set([...deps, ...selfProvidedPeers])];
}

/**
 * Ensure each source-consumed sibling has its full dependency closure installed, so the
 * consumer's source build resolves every transitive import. Cheap fs check first (steady
 * state = no-op); only when a required dep is actually absent do we self-heal with a
 * `bun install` in the sibling. Forced to NODE_ENV=development so the sibling's
 * devDependencies (which carry its optional feature peers) are installed even when the
 * parent install ran under NODE_ENV=production. Best-effort — a failure warns but never
 * aborts the relink.
 */
function ensureSourceDepsInstalled(hub: string): void {
  const seen = new Set<string>();
  for (const { deps } of TARGETS) {
    for (const dep of deps) {
      const target = targetFor(hub, dep);
      if (seen.has(target) || !existsSync(target)) continue;
      seen.add(target);
      const pkg = readJson(join(target, "package.json"));
      if (!pkg || !isSourceConsumed(pkg)) continue;
      const nm = join(target, "node_modules");
      const missing = requiredDeps(pkg).filter((d) => !existsSync(join(nm, d)));
      if (missing.length === 0) continue;
      const preview = missing.slice(0, 6).join(", ") + (missing.length > 6 ? ", …" : "");
      console.log(
        `relink: ${dep} (source-consumed) is missing ${missing.length} dep(s) in its node_modules ` +
          `(${preview}); running \`bun install\` in ${target}`,
      );
      try {
        execSync("bun install", { cwd: target, stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } });
      } catch (err) {
        console.warn(
          `relink: WARNING — \`bun install\` in ${target} failed: ${err instanceof Error ? err.message : err}. ` +
            `The source build may not resolve ${dep}'s deps until it is installed.`,
        );
      }
    }
  }
}

try {
  const hub = findHub();
  relink(hub);
  ensureSourceDepsInstalled(hub);
} catch (err) {
  // Best-effort: never break an install over a relink hiccup, but be loud about it.
  console.warn(
    `relink: WARNING — could not refresh first-party symlinks: ${err instanceof Error ? err.message : err}`,
  );
}
