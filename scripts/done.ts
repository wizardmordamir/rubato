#!/usr/bin/env bun
/**
 * `bun run done` — the pre-land verification gate. Runs, fail-fast, the checks
 * that define "verified" for a worktree: typecheck → format+lint (non-mutating)
 * → the test suite (unit · integration · functional). Pass `--e2e` (or `--full`)
 * to also run the Playwright smoke suite (needs Chrome). Land only when this is
 * green.
 */

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));
const wantE2e = args.has("--e2e") || args.has("--full");

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
  await step("tests (unit · integration · functional)", ["bun", "test"]);
  if (wantE2e) await step("e2e (Playwright smoke)", ["bun", "run", "e2e"]);
  console.log(`\n✅ done — ${wantE2e ? "all checks incl. e2e" : "tsc · lint · tests"} passed.`);
}

if (import.meta.main) await main();
