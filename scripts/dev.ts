#!/usr/bin/env bun
/**
 * `bun run dev` — run the whole stack in one terminal: the `rubato-serve` API
 * server (:4747) and the Vite UI dev server (:5173, proxies /api). Each line is
 * prefixed with a colored `[server]` / `[web]` label so the interleaved output
 * stays readable. Ctrl-C (or either process exiting) tears both down.
 *
 * The server runs through scripts/devServer.ts (not a bare `bun --hot`) so it
 * survives the linked-cwip rebuild window — see that file. It still hot-reloads
 * on src/ changes.
 */

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

const procs: Bun.Subprocess[] = [];
let stopping = false;

/** Prefix each line of a child stream with a colored label. */
async function pipe(stream: ReadableStream<Uint8Array>, label: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`${label} ${line}\n`);
  }
  if (buf) process.stdout.write(`${label} ${buf}\n`);
}

function start(label: string, cmd: string[], cwd: string): Bun.Subprocess {
  const proc = Bun.spawn(cmd, { cwd, env: process.env, stdout: "pipe", stderr: "pipe", stdin: "inherit" });
  procs.push(proc);
  pipe(proc.stdout as ReadableStream<Uint8Array>, label);
  pipe(proc.stderr as ReadableStream<Uint8Array>, label);
  return proc;
}

function shutdown(code = 0): never {
  stopping = true;
  for (const p of procs) p.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const server = start(`${CYAN}[server]${RESET}`, ["bun", "run", "scripts/devServer.ts"], ROOT);
const web = start(`${MAGENTA}[web]${RESET}`, ["bun", "run", "dev"], resolve(ROOT, "ui"));

// If either side dies, take the whole dev environment down (non-zero so the
// failure is visible) — running half the stack is rarely what you want.
const exited = await Promise.race([server.exited, web.exited]);
if (!stopping) shutdown(typeof exited === "number" ? exited : 1);
