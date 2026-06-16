#!/usr/bin/env bun
/**
 * run-capture — internal wrapper the generated shell functions call for `plain`,
 * capture-enabled commands (see setup-aliases.ts / commands.ts).
 *
 * It runs a registered command, streams the output live to the terminal AND tees
 * a copy to the configured output dir (the latest run per command, overwritten on
 * the next run), records the run in the server's SQLite store so the web UI sees
 * terminal-triggered runs too, then prints the saved file path as the final line
 * so you can cmd+click it.
 *
 * Trade-off: stdout/stderr are piped (not inherited) to capture them, so the child
 * loses its TTY and may disable color. Commands that need a real TTY opt out via
 * `capture: false` in commands.ts and never reach here.
 *
 * Usage (normally invoked by the alias, not by hand):
 *   bun run src/scripts/run-capture.ts <command> [args...]
 */

import { COMMANDS } from '../commands';
import { reportPathForRun } from '../lib/dataReport';
import { findPackageRoot, resolveScript } from '../lib/pkgPaths';
import { writeLatestOutput } from '../lib/runStore';
import { recordRun } from '../server/db';

const REPO_ROOT = findPackageRoot(import.meta.dir);
const MAX_OUTPUT = 64_000;

/** Stream a child stream to `sink` live while accumulating decoded text. */
async function tee(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream, onText: (s: string) => void) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    sink.write(chunk);
    onText(decoder.decode(chunk, { stream: true }));
  }
  onText(decoder.decode());
}

async function main() {
  const [name, ...args] = process.argv.slice(2);
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    console.error(`rubato: unknown command "${name}".`);
    process.exit(1);
  }

  const startedAt = Date.now();
  const proc = Bun.spawn(['bun', 'run', resolveScript(REPO_ROOT, cmd.script), ...args], {
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let buffer = '';
  const append = (s: string) => {
    buffer += s;
  };
  const [, , exitCode] = await Promise.all([
    tee(proc.stdout, process.stdout, append),
    tee(proc.stderr, process.stderr, append),
    proc.exited,
  ]);

  let savedPath = '';
  try {
    savedPath = await writeLatestOutput(name, args, exitCode, buffer, startedAt);
    recordRun({
      command: name,
      args,
      exitCode,
      output: buffer.slice(0, MAX_OUTPUT),
      outputPath: savedPath,
      reportPath: await reportPathForRun(name, startedAt),
      startedAt,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error(`rubato: could not save output: ${err instanceof Error ? err.message : err}`);
  }

  // Final line so the saved path is the last thing on screen (cmd+click target).
  if (savedPath) process.stdout.write(`\n📄 output saved: ${savedPath}\n`);
  process.exit(exitCode);
}

if (import.meta.main) main();
