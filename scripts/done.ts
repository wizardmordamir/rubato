#!/usr/bin/env bun
/**
 * `bun run done` — the pre-land verification gate. Runs, fail-fast, the checks
 * that define "verified" for a worktree: typecheck → format+lint (non-mutating)
 * → LOADCHECK (does localhost actually load?) → the test suite (unit · integration
 * · functional). Pass `--e2e` (or `--full`) to also run the Playwright smoke suite
 * (needs Chrome). Land only when this is green.
 *
 * The loadcheck runs BEFORE the slow test suite on purpose: it's the cheapest,
 * highest-signal check (boot localhost, navigate every top-nav route, assert each
 * page mounts its real content — not a white-screen or a "Failed to load" error
 * boundary). A green tsc + green tests DON'T prove the site loads, so without this a
 * worker can mark "done" while localhost is broken. Skip with `--no-loadcheck` (e.g.
 * a docs-only change); it degrades to INCONCLUSIVE (non-fatal) where no browser exists.
 */

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));
const wantE2e = args.has("--e2e") || args.has("--full");
const skipLoad = args.has("--no-loadcheck");

async function step(label: string, cmd: string[]): Promise<void> {
  console.log(`\n▶ ${label}\n  $ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\n❌ ${label} failed (exit ${code}). Fix it before landing.`);
    process.exit(code);
  }
}

async function main(): Promise<void> {
  await step("typecheck", ["bun", "run", "tsc"]);
  // Non-mutating: fails on lint errors / unformatted code (unlike `bun run lint`,
  // which auto-fixes). Keep the tree clean with `bun run biome` before landing.
  await step("format + lint (biome check)", ["bunx", "biome", "check", "./src"]);
  // LOADCHECK FIRST (before the slow suite): does the real UI on localhost load?
  if (!skipLoad) await step("loadcheck (localhost loads + navigates)", ["bun", "run", "scripts/loadcheck.ts"]);
  await step("tests (unit · integration · functional)", ["bun", "test"]);
  if (wantE2e) await step("e2e (Playwright smoke)", ["bun", "run", "e2e"]);
  console.log(`\n✅ done — ${wantE2e ? "all checks incl. e2e" : "tsc · lint · loadcheck · tests"} passed.`);
}

if (import.meta.main) await main();
