#!/usr/bin/env bun
/**
 * setup — provision a checkout (or git worktree) so it can fully build, run, and
 * test rubato, including the web UI and the Playwright e2e suite.
 *
 * rubato runs from raw `.ts` (no build to *use* it), but a fresh worktree still
 * needs its own `node_modules` on BOTH sides (root + `ui/`), and the e2e suite
 * needs a browser. This script does all of that, idempotently, in one command:
 *
 *     bun run setup            # root + ui installs (what every worktree needs)
 *     bun run setup --browsers # also download Playwright's Chromium (headless/CI)
 *     bun run setup --ai       # also stage the local embedding model (rubato-ai-setup)
 *     bun run setup --full     # everything above
 *
 * `playwright` and `@huggingface/transformers` are optional peer deps but are also
 * listed in devDependencies, so the two `bun install`s already fetch them. The
 * e2e suite drives your installed Google Chrome by default (`channel: "chrome"`),
 * so `--browsers` is only needed where Chrome isn't present (CI / headless boxes).
 *
 * See CLAUDE.md → "Running the app + e2e from a worktree" for the isolation model
 * (per-worktree RUBATO_HOME + RUBATO_PORT) that lets several worktrees run at once.
 */

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));
const want = (flag: string) => args.has(flag) || args.has("--full");

/** Run a command, inheriting stdio, and throw with a clear label if it fails. */
async function run(label: string, cmd: string[], cwd = ROOT): Promise<void> {
  console.log(`\n▶ ${label}\n  $ ${cmd.join(" ")}  (in ${cwd === ROOT ? "." : cwd.replace(`${ROOT}/`, "")})`);
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

async function main(): Promise<void> {
  // 1. Dependencies — both workspaces. These also pull the optional peer deps
  //    (playwright, transformers) since they're in devDependencies.
  await run("install root dependencies", ["bun", "install"]);
  await run("install ui dependencies", ["bun", "install"], resolve(ROOT, "ui"));

  // 2. Browsers — only needed where system Chrome is absent (the e2e suite and the
  //    automation builder default to channel:"chrome"). Opt-in because it's heavy.
  if (want("--browsers")) {
    await run("download Playwright Chromium", ["bun", "x", "playwright", "install", "chromium"]);
  }

  // 3. Local embedding model for the "Ask about your repo" RAG features. Opt-in.
  if (want("--ai")) {
    await run("stage local embedding model", ["bun", "run", "src/scripts/ai-setup.ts"]);
  }

  console.log("\n✅ setup complete. Next:");
  console.log("   bun run tsc && bun run test     # verify");
  console.log("   bun run serve                   # run the app (see CLAUDE.md for worktree isolation)");
  console.log("   bun run e2e                     # run the Playwright smoke suite");
}

main().catch((err) => {
  console.error(`\n❌ setup failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
