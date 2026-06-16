#!/usr/bin/env bun
/**
 * setup-aliases  (installed as `rubato-setup`)
 *
 * Makes every rubato command runnable from anywhere as a memorable shell name.
 *
 * What it does:
 *   1. Generates ~/.rubato-scripts/aliases.sh — a shell function per command
 *      (read from src/commands.ts), each calling its TypeScript script via bun.
 *   2. Injects an idempotent managed block into your shell rc (~/.zshrc by
 *      default) that sources that file on shell startup.
 *
 * Why shell functions and not a one-off `bun run`: functions let commands pass
 * args through cleanly, and let "cd"-kind commands change your current shell's
 * directory (a subprocess can't). Bun is resolved at call time so it works even
 * in minimal-PATH shells.
 *
 * Usage:
 *   bun run src/scripts/setup-aliases.ts            # generate + wire into shell rc
 *   bun run src/scripts/setup-aliases.ts --dry-run  # preview, write nothing
 *   bun run src/scripts/setup-aliases.ts --print    # print generated aliases.sh
 *   bun run src/scripts/setup-aliases.ts --rc ~/.bashrc [--rc ...]
 *
 * Re-run any time after adding a command (or via `rubato-setup`).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { $ } from 'bun';
import { COMMANDS } from '../commands';
import { findPackageRoot, resolveScript } from '../lib/pkgPaths';

const REPO_ROOT = findPackageRoot(import.meta.dir);
const RUBATO_DIR = resolve(homedir(), '.rubato-scripts');
const ALIASES_FILE = resolve(RUBATO_DIR, 'aliases.sh');
const INDEX_SCRIPT = resolveScript(REPO_ROOT, 'src/index.ts');
const RUN_CAPTURE_SCRIPT = resolveScript(REPO_ROOT, 'src/scripts/run-capture.ts');

const MARKER_START = '# >>> rubato (managed) >>>';
const MARKER_END = '# <<< rubato (managed) <<<';

interface Options {
  rcFiles: string[];
  dryRun: boolean;
  print: boolean;
}

/** Single-quote a string for safe embedding in shell (handles spaces, etc.). */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function expandPath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getHelp(): string {
  return [
    'rubato-setup — install rubato commands as shell functions',
    '',
    'Usage: bun run src/scripts/setup-aliases.ts [options]',
    '',
    'Options:',
    '  --dry-run     Preview changes without writing',
    '  --print       Print the generated aliases.sh and exit',
    '  --rc <file>   Shell rc file to wire into (repeatable; default by $SHELL)',
    '  -h, --help    Show this help',
  ].join('\n');
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { rcFiles: [], dryRun: false, print: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        console.log(getHelp());
        process.exit(0);
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--print':
        opts.print = true;
        break;
      case '--rc': {
        const value = argv[++i];
        if (!value) {
          console.error('error: --rc requires a value');
          process.exit(1);
        }
        opts.rcFiles.push(value);
        break;
      }
      default:
        console.error(`error: unknown option "${arg}"`);
        process.exit(1);
    }
  }
  return opts;
}

/** The rc file(s) to wire into, inferred from the user's shell. */
function defaultRcFiles(): string[] {
  const shell = (process.env.SHELL ?? '').split('/').pop() ?? '';
  if (shell.includes('zsh')) return ['~/.zshrc'];
  if (shell.includes('bash')) return ['~/.bashrc'];
  // Unknown/other shell: wire into whichever POSIX rc already exists (the managed
  // block is `sh` syntax, so fish etc. would need --rc explicitly), else ~/.profile.
  for (const rc of ['~/.zshrc', '~/.bashrc', '~/.profile']) {
    if (existsSync(expandPath(rc))) return [rc];
  }
  return ['~/.profile'];
}

/** Build the contents of ~/.rubato-scripts/aliases.sh from the command registry. */
function generateAliasesFile(): string {
  const out: string[] = [];
  out.push('# rubato shell commands — GENERATED FILE, do not edit by hand.');
  out.push(`# Regenerate with: rubato-setup   (or: bun run ${REPO_ROOT}/src/scripts/setup-aliases.ts)`);
  out.push(`# Repo: ${REPO_ROOT}`);
  out.push('');
  out.push('# Resolve and invoke bun reliably, even when PATH is minimal.');
  out.push('__rubato_runbun() {');
  out.push('  local __bun');
  out.push('  __bun="$(command -v bun 2>/dev/null)"');
  out.push('  if [ -z "$__bun" ]; then');
  out.push('    echo "rubato: bun not found in PATH" >&2');
  out.push('    return 1');
  out.push('  fi');
  out.push('  "$__bun" "$@"');
  out.push('}');
  out.push('');
  out.push('# rubato [list|<command> [args]] — discover or run any rubato command.');
  out.push('rubato() {');
  out.push(`  __rubato_runbun ${shq(INDEX_SCRIPT)} "$@"`);
  out.push('}');
  out.push('');

  for (const cmd of COMMANDS) {
    const scriptPath = resolveScript(REPO_ROOT, cmd.script);
    out.push(`# ${cmd.description}`);
    out.push(`${cmd.name}() {`);
    if (cmd.kind === 'cd') {
      out.push('  local __out');
      out.push(`  __out="$(__rubato_runbun ${shq(scriptPath)} "$@")" || return $?`);
      out.push('  [ -n "$__out" ] && cd "$__out"');
    } else if (cmd.capture === false) {
      out.push(`  __rubato_runbun ${shq(scriptPath)} "$@"`);
    } else {
      // Route through the capture wrapper: streams live + tees output to a file.
      out.push(`  __rubato_runbun ${shq(RUN_CAPTURE_SCRIPT)} ${shq(cmd.name)} "$@"`);
    }
    out.push('}');
    out.push('');
  }

  return `${out.join('\n')}\n`;
}

function buildRcBlock(): string {
  return [
    MARKER_START,
    '# Loads rubato shell commands. Regenerate with: rubato-setup',
    '[ -f "$HOME/.rubato-scripts/aliases.sh" ] && . "$HOME/.rubato-scripts/aliases.sh"',
    MARKER_END,
  ].join('\n');
}

type InjectStatus = 'created' | 'added' | 'updated' | 'unchanged';

/** Idempotently add/update the managed block in a single rc file. */
async function injectRcBlock(rcPath: string, dryRun: boolean): Promise<InjectStatus> {
  const file = Bun.file(rcPath);
  const existed = await file.exists();
  const content = existed ? await file.text() : '';
  const block = buildRcBlock();
  const blockRe = new RegExp(`${escapeRe(MARKER_START)}[\\s\\S]*?${escapeRe(MARKER_END)}`);

  let next: string;
  let status: InjectStatus;
  if (blockRe.test(content)) {
    next = content.replace(blockRe, block);
    status = next === content ? 'unchanged' : 'updated';
  } else {
    const sep = content.length === 0 ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    next = `${content}${sep}${block}\n`;
    status = existed ? 'added' : 'created';
  }

  if (!dryRun && status !== 'unchanged') {
    await $`mkdir -p ${dirname(rcPath)}`.quiet();
    await Bun.write(rcPath, next);
  }
  return status;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rcTargets = (opts.rcFiles.length ? opts.rcFiles : defaultRcFiles()).map(expandPath);
  const aliasesContent = generateAliasesFile();

  if (opts.print) {
    process.stdout.write(aliasesContent);
    return;
  }

  const commandNames = ['rubato', ...COMMANDS.map((c) => c.name)];

  if (opts.dryRun) {
    console.log('🔎 Dry run — nothing written.\n');
    console.log(`Would write: ${ALIASES_FILE}`);
    console.log(`Commands:    ${commandNames.join(', ')}`);
    for (const rc of rcTargets) {
      const status = await injectRcBlock(rc, true);
      console.log(`rc ${rc}: would be ${status}`);
    }
    return;
  }

  await $`mkdir -p ${RUBATO_DIR}`.quiet();
  await Bun.write(ALIASES_FILE, aliasesContent);
  console.log(`✅ Wrote ${ALIASES_FILE}`);
  console.log(`   Commands: ${commandNames.join(', ')}`);

  for (const rc of rcTargets) {
    const status = await injectRcBlock(rc, false);
    console.log(`🔧 ${rc}: ${status}`);
  }

  console.log(`\nActivate now:  source ${rcTargets[0]}`);
  console.log('Then try:      rubato list');
}

if (import.meta.main)
  main().catch((err) => {
    console.error('❌ Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
