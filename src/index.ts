#!/usr/bin/env bun
/**
 * rubato — umbrella command.
 *
 *   rubato                 list available commands
 *   rubato list            same
 *   rubato <name> [args]   run a command by name
 *
 * Individual commands are also installed as standalone shell functions by
 * `rubato-setup`, so you can usually just type e.g. `globalgitignore` directly.
 * Note: "cd"-kind commands only change your shell's directory when invoked via
 * their own function — not through `rubato <name>` (a subprocess can't cd you).
 */

import { COMMANDS } from './commands';
import { findPackageRoot, resolveScript } from './lib/pkgPaths';

const REPO_ROOT = findPackageRoot(import.meta.dir);
const RUN_CAPTURE_SCRIPT = resolveScript(REPO_ROOT, 'src/scripts/run-capture.ts');

function list(): void {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  console.log('rubato commands:\n');
  for (const c of COMMANDS) {
    console.log(`  ${c.name.padEnd(width)}  ${c.description}`);
  }
  console.log('\nRun directly by name (after rubato-setup), or: rubato <name> [args]');
}

async function run(): Promise<number> {
  const [name, ...args] = process.argv.slice(2);

  if (!name || ['list', 'help', '-h', '--help'].includes(name)) {
    list();
    return 0;
  }

  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    console.error(`rubato: unknown command "${name}". Run \`rubato list\`.`);
    return 1;
  }

  // Plain capture-enabled commands go through the capture wrapper (tees output to
  // a file, prints the saved path); cd-kind and capture-exempt run directly.
  const target =
    cmd.kind === 'plain' && cmd.capture !== false
      ? [RUN_CAPTURE_SCRIPT, cmd.name, ...args]
      : [resolveScript(REPO_ROOT, cmd.script), ...args];
  const proc = Bun.spawn(['bun', 'run', ...target], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  return proc.exited;
}

process.exit(await run());
