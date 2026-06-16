#!/usr/bin/env bun
/**
 * Dev runner for the rubato server that survives the linked-cwip rebuild window.
 *
 * `bun link cwip` symlinks node_modules/cwip to the sibling cwip repo. When that
 * repo rebuilds, its `clean` step does `rm -rf dist`, briefly removing cwip. A
 * plain `bun --hot run …/serve.ts` reloads into that window, fails with "Cannot
 * find package 'cwip'", and does NOT recover — it keeps watching the now-deleted
 * (different inode) files, so it never reloads when dist reappears, forcing a
 * manual restart.
 *
 * This runner instead:
 *   * runs the server as a child (no --hot; we own restarts),
 *   * fs.watch()es src/ for instant hot-reload,
 *   * POLLS the linked cwip build output (polling survives delete+recreate,
 *     unlike fs.watch) and restarts when it changes, and
 *   * auto-retries if the child exits unexpectedly (e.g. spawned mid-rebuild),
 *     so it heals itself once cwip finishes building.
 *
 * Ported from cursedalchemy's server/scripts/devServer.ts. Args are passed
 * through to serve.ts (e.g. `--port`, `--open`); env (RUBATO_HOME/RUBATO_PORT) is
 * inherited.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync, watch } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const entry = "src/scripts/serve.ts";
const srcDir = resolve(root, "src");
// Linked cwip's build output; a rebuild here should restart the server.
const cwipMain = resolve(root, "node_modules/cwip/dist/index.js");
const passthrough = process.argv.slice(2);

const RESTART_DEBOUNCE_MS = 150;
const CRASH_RETRY_MS = 700;
const CWIP_POLL_MS = 700;

const log = (msg: string) => console.log(`\x1b[36m[dev]\x1b[0m ${msg}`);

let child: ChildProcess | null = null;
let intentionalRestart = false;
let crashRetryTimer: ReturnType<typeof setTimeout> | undefined;

const childIsRunning = () => !!child && child.exitCode === null && !child.killed;

const startChild = () => {
  clearTimeout(crashRetryTimer);
  if (childIsRunning()) return; // guard against double-spawn (avoids port clash)
  intentionalRestart = false;
  child = spawn("bun", ["run", entry, ...passthrough], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (intentionalRestart || signal) return; // our restart, or Ctrl+C
    // Unexpected crash — commonly cwip missing mid-rebuild. Keep retrying until
    // it comes back.
    log(`server exited (code ${code}); retrying in ${CRASH_RETRY_MS}ms…`);
    crashRetryTimer = setTimeout(startChild, CRASH_RETRY_MS);
  });
};

const restart = (reason: string) => {
  clearTimeout(crashRetryTimer);
  log(`restarting (${reason})`);
  if (childIsRunning()) {
    intentionalRestart = true;
    child?.once("exit", startChild);
    child?.kill("SIGTERM");
  } else {
    startChild();
  }
};

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleRestart = (reason: string) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => restart(reason), RESTART_DEBOUNCE_MS);
};

// 1. Our own source → instant hot-reload.
watch(srcDir, { recursive: true }, (_event, file) => {
  if (file && /\.(ts|tsx|js|jsx|json)$/.test(file)) scheduleRestart(`src: ${file}`);
});

// 2. Linked cwip output → reload to pick up the rebuild. Polling (not fs.watch)
// because cwip's `clean` deletes the dir, which would kill an fs.watch handle.
let lastCwipSig = "";
setInterval(() => {
  const sig = existsSync(cwipMain) ? String(statSync(cwipMain).mtimeMs) : "missing";
  if (lastCwipSig && sig !== lastCwipSig && sig !== "missing") {
    scheduleRestart("cwip rebuilt");
  }
  lastCwipSig = sig;
}, CWIP_POLL_MS);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    intentionalRestart = true;
    child?.kill(sig);
    process.exit(0);
  });
}

log("starting server (watching src/ + linked cwip)…");
startChild();
