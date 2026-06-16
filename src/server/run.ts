/**
 * Run a rubato command from the server and record it. Registry commands run their
 * known script; user-saved commands can also run an arbitrary shell line (the
 * server is loopback-only and the user authored them). Interactive prompts have
 * no TTY here, so destructive commands abort unless given an explicit flag
 * (e.g. deploy/startprs need --yes) — a safe default for a web trigger.
 *
 * Every run is appended to the run history (`recordRunHistory`). Registry runs
 * also upsert the latest-per-command `runs` row; saved shell runs only go to the
 * history (they aren't in the registry).
 */

import { COMMANDS } from '../commands';
import { expandPath } from '../lib/config';
import { reportPathForRun } from '../lib/dataReport';
import { startDiagnostics } from '../lib/diagnostics';
import { findPackageRoot, resolveScript } from '../lib/pkgPaths';
import { writeLatestOutput } from '../lib/runStore';
import type { RunHistoryRecord, RunRecord, SavedCommand } from '../shared/types';
import { bumpCommandStat, type CommandStatScope, recordRun, recordRunHistory } from './db';
import { emit } from './events';

const REPO_ROOT = findPackageRoot(import.meta.dir);
const MAX_OUTPUT = 64_000;
/** Tail of stderr to surface in a failed run's diagnostic report. */
const STDERR_TAIL = 4_000;

/**
 * Write a diagnostic report for a finished run and return its report path. The
 * report carries what ran + exit code + stderr tail + a redacted env/config
 * snapshot, so a failure on someone else's machine is debuggable from the file
 * alone. Best-effort — never blocks the run.
 */
async function writeRunDiagnostic(args: {
  activity: string;
  intent: string;
  command: string;
  cmdArgs: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  outputPath?: string;
  startedAt: number;
}): Promise<string | undefined> {
  try {
    const d = startDiagnostics({ activity: args.activity, intent: args.intent, console: false });
    d.step('started', { command: args.command, args: args.cmdArgs });
    d.info('finished', {
      exitCode: args.exitCode,
      durationMs: Date.now() - args.startedAt,
      outputBytes: args.stdout.length + args.stderr.length,
      outputPath: args.outputPath,
    });
    if (args.exitCode !== 0) {
      d.error(`exited ${args.exitCode}`, { stderrTail: args.stderr.slice(-STDERR_TAIL) });
    }
    const res = await d.finish(args.exitCode === 0 ? 'ok' : 'error');
    return res.reportPath;
  } catch {
    return undefined;
  }
}

/**
 * How to attribute a run in `command_stats`. Defaults to the builtin command by
 * name; a saved command passes `{ scope: 'saved', key: savedId }` so its own run
 * count is tracked separately from the underlying builtin's direct invocations.
 */
export interface RunStatTarget {
  scope: CommandStatScope;
  key: string;
}

export async function runCommand(
  name: string,
  args: string[],
  startedAt: number,
  countAs?: RunStatTarget,
): Promise<RunRecord> {
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) throw new Error(`unknown command: ${name}`);

  emit({ type: 'run:started', command: name, args });

  const proc = Bun.spawn(['bun', 'run', resolveScript(REPO_ROOT, cmd.script), ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const full = `${stdout}${stderr}`;
  // Save the full output to the configured dir (the cmd+click artifact); the DB
  // keeps a truncated copy as the UI's source of truth.
  const outputPath = await writeLatestOutput(name, args, exitCode, full, startedAt).catch(() => undefined);
  const diagnosticPath = await writeRunDiagnostic({
    activity: `run-${name}`,
    intent: cmd.description ?? `run ${name}`,
    command: name,
    cmdArgs: args,
    exitCode,
    stdout,
    stderr,
    outputPath,
    startedAt,
  });
  // Link the structured data report this run's subprocess just wrote (if any) —
  // the path is deterministic, so we attach it only when it was (re)written now.
  const reportPath = await reportPathForRun(name, startedAt);
  const run = recordRun({
    command: name,
    args,
    exitCode,
    output: full.slice(0, MAX_OUTPUT),
    outputPath,
    diagnosticPath,
    reportPath,
    startedAt,
    durationMs: Date.now() - startedAt,
  });
  const { id: _id, ...fields } = run;
  recordRunHistory({ ...fields, source: 'builtin' });
  bumpCommandStat(countAs?.scope ?? 'builtin', countAs?.key ?? name, exitCode, startedAt);
  emit({ type: 'run:completed', run });
  return run;
}

/**
 * Run an arbitrary shell command line (a user-saved "shell" command). Recorded in
 * the run history only — it isn't a registry command, so it never touches the
 * latest-per-command `runs` table. Output also lands in a `saved-<name>.txt` file.
 */
export async function runShellCommand(
  name: string,
  shell: string,
  cwd: string | undefined,
  startedAt: number,
  savedId?: string,
): Promise<RunHistoryRecord> {
  emit({ type: 'run:started', command: name, args: [] });

  const proc = Bun.spawn(['bash', '-lc', shell], {
    cwd: cwd?.length ? cwd : REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const full = `${stdout}${stderr}`;
  const outputPath = await writeLatestOutput(`saved-${name}`, [], exitCode, full, startedAt).catch(() => undefined);
  const diagnosticPath = await writeRunDiagnostic({
    activity: `saved-${name}`,
    intent: `saved shell command: ${shell}`,
    command: name,
    cmdArgs: [],
    exitCode,
    stdout,
    stderr,
    outputPath,
    startedAt,
  });
  const rec = recordRunHistory({
    command: name,
    args: [],
    exitCode,
    output: full.slice(0, MAX_OUTPUT),
    outputPath,
    diagnosticPath,
    startedAt,
    durationMs: Date.now() - startedAt,
    source: 'saved',
  });
  if (savedId) bumpCommandStat('saved', savedId, exitCode, startedAt);
  emit({ type: 'run:completed', run: rec });
  return rec;
}

/**
 * Run a saved command: a "builtin" runs the registry command with its preset
 * args; a "shell" runs its command line with bash. Returns the recorded run.
 */
export async function runSavedCommand(saved: SavedCommand): Promise<RunRecord> {
  // Attribute the run to the SAVED command (not the underlying builtin), so the
  // saved card shows its own run count and the builtin's count stays = direct runs.
  if (saved.kind === 'builtin') {
    return runCommand(saved.command, saved.args, Date.now(), { scope: 'saved', key: saved.id });
  }
  return runShellCommand(
    saved.name,
    saved.command,
    saved.cwd ? expandPath(saved.cwd) : undefined,
    Date.now(),
    saved.id,
  );
}

/**
 * Start a run without waiting for it — the completion arrives over the socket as
 * a "run:completed" event. This is the "fire a deploy, get notified when it
 * finishes" path. Failures are surfaced as a completed run with a non-zero code.
 */
export function startBackgroundRun(name: string, args: string[]): void {
  runCommand(name, args, Date.now()).catch((err) => {
    emit({
      type: 'run:completed',
      run: {
        id: 0,
        command: name,
        args,
        exitCode: 1,
        output: err instanceof Error ? err.message : String(err),
        startedAt: Date.now(),
        durationMs: 0,
      },
    });
  });
}
