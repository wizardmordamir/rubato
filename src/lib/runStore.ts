/**
 * Shared store for command run outputs. The latest run of each command is
 * written to a file in the output dir (~/.rubato/outputs), overwritten on the next
 * run of that command. Used by both the CLI capture wrapper (scripts/run-capture.ts)
 * and the web server (server/run.ts) so a run triggered from the terminal and one
 * from the web land in the same place. The file is the cmd+click artifact; the
 * server's SQLite row is the UI's source of truth.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OUTPUTS_DIR } from './config';

/** The output directory (absolute) — always ~/.rubato/outputs (see OUTPUTS_DIR). */
export async function resolveOutputDir(): Promise<string> {
  return OUTPUTS_DIR;
}

/**
 * The output dir, created if missing. Report-writing scripts default their output
 * here (when no explicit `--out`) so the web UI's "Files" tab can show them.
 */
export async function ensureOutputDir(): Promise<string> {
  const dir = await resolveOutputDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Filesystem-safe single-segment file name for a command. */
function safeName(command: string): string {
  return command.replace(/[^a-zA-Z0-9._-]/g, '_') || 'command';
}

/**
 * Write a command's latest output to <outputDir>/<command>.txt (replacing any
 * prior run of that command) and return the absolute file path. The file leads
 * with a one-line header so it's self-describing when opened on its own.
 */
export async function writeLatestOutput(
  command: string,
  args: string[],
  exitCode: number,
  output: string,
  startedAt: number,
): Promise<string> {
  const dir = await resolveOutputDir();
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, `${safeName(command)}.txt`);
  const cmdline = [command, ...args].join(' ').trim();
  const header = `# ${cmdline} — exit ${exitCode} — ${new Date(startedAt).toISOString()}\n\n`;
  await Bun.write(file, header + output);
  return file;
}
