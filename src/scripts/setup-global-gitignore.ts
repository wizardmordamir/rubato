#!/usr/bin/env bun
/**
 * setup-global-gitignore
 *
 * Configures git's global ignore file (`core.excludesFile`) and merges a
 * curated set of machine- and editor-specific patterns into it, so every repo
 * on this machine ignores them without polluting per-project .gitignore files.
 *
 * Re-running is safe: only patterns that are missing get appended, existing
 * lines and ordering are preserved.
 *
 * The default patterns live in an editable template file
 * (src/scripts/assets/global.gitignore), not in this script — edit that file to
 * change what every repo ignores, then re-run.
 *
 * Usage:
 *   bun run src/scripts/setup-global-gitignore.ts [patterns...] [options]
 *
 * Examples:
 *   bun run src/scripts/setup-global-gitignore.ts
 *   bun run src/scripts/setup-global-gitignore.ts ".vscode/" "*.local"
 *   bun run src/scripts/setup-global-gitignore.ts --dry-run
 *   bun run src/scripts/setup-global-gitignore.ts --print
 *   bun run src/scripts/setup-global-gitignore.ts --path ~/.gitignore_global
 *
 * Options:
 *   --path <file>   Path to use for the global ignore file (default: existing
 *                   core.excludesFile, else ~/.gitignore_global).
 *   --print         Print the default template patterns and exit.
 *   --dry-run       Print the changes that would be made without writing.
 *   -h, --help      Show this help.
 */

import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { $ } from 'bun';

/** Editable source of truth for the default patterns. */
const TEMPLATE_FILE = resolve(import.meta.dir, 'assets/global.gitignore');

/**
 * Load the curated default patterns (and their `# --- Section ---` headers) from
 * the template file. The file's leading documentation block — everything before
 * the first section header — is meta-docs for the template itself and is dropped
 * so it never leaks into the user's global ignore. Trailing blanks are trimmed.
 */
async function loadDefaultPatterns(): Promise<string[]> {
  const file = Bun.file(TEMPLATE_FILE);
  if (!(await file.exists())) {
    throw new Error(`default template not found: ${TEMPLATE_FILE}`);
  }
  const lines = (await file.text()).replace(/\n+$/, '').split('\n');
  const firstSection = lines.findIndex((l) => l.startsWith('# ---'));
  return firstSection === -1 ? lines : lines.slice(firstSection);
}

interface Options {
  path?: string;
  dryRun: boolean;
  print: boolean;
  extraPatterns: string[];
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dryRun: false, print: false, extraPatterns: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        console.log(getHelp());
        process.exit(0);
        break;
      case '--print':
        opts.print = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--path':
        opts.path = argv[++i];
        if (!opts.path) {
          console.error('error: --path requires a value');
          process.exit(1);
        }
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`error: unknown option "${arg}"`);
          process.exit(1);
        }
        opts.extraPatterns.push(arg);
    }
  }

  return opts;
}

function getHelp(): string {
  // The leading doc comment is the source of truth; keep this concise.
  return [
    "setup-global-gitignore — configure git's global ignore file",
    '',
    'Usage: bun run src/scripts/setup-global-gitignore.ts [patterns...] [options]',
    '',
    'Options:',
    '  --path <file>   Global ignore file to use (default: core.excludesFile or ~/.gitignore_global)',
    '  --print         Print the default template patterns and exit',
    '  --dry-run       Show changes without writing',
    '  -h, --help      Show this help',
  ].join('\n');
}

/** Expand a leading `~` to the user's home directory and absolutize. */
function expandPath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/** Read the currently configured global excludesFile, if any. */
async function getConfiguredExcludesFile(): Promise<string | null> {
  const result = await $`git config --global core.excludesFile`.nothrow().quiet();
  if (result.exitCode !== 0) return null;
  const value = result.stdout.toString().trim();
  return value || null;
}

/**
 * A line counts as "already present" if its trimmed pattern matches an existing
 * pattern. Comments and blank lines are structural and not deduped against.
 */
function isPattern(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith('#');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const defaultPatterns = await loadDefaultPatterns();

  if (opts.print) {
    console.log(defaultPatterns.join('\n'));
    return;
  }

  // Resolve the target ignore file: explicit flag > configured > default.
  const configured = await getConfiguredExcludesFile();
  const rawPath = opts.path ?? configured ?? '~/.gitignore_global';
  const ignorePath = expandPath(rawPath);

  // Read existing contents (empty if the file doesn't exist yet).
  const file = Bun.file(ignorePath);
  const existingContent = (await file.exists()) ? await file.text() : '';
  const existingLines = existingContent.length ? existingContent.replace(/\n+$/, '').split('\n') : [];
  const existingPatterns = new Set(existingLines.filter(isPattern).map((l) => l.trim()));

  // Figure out which patterns from our desired set are missing. Comment/blank
  // lines from a section are only carried over if that section adds something.
  const desired = [...defaultPatterns, ...opts.extraPatterns];
  const toAppend: string[] = [];
  let pendingHeader: string[] = [];

  for (const line of desired) {
    if (!isPattern(line)) {
      pendingHeader.push(line);
      continue;
    }
    if (existingPatterns.has(line.trim())) {
      // Section already present; drop its header so it isn't re-emitted.
      pendingHeader = [];
      continue;
    }
    // This pattern is new: flush any pending header lines first.
    if (pendingHeader.length) {
      toAppend.push(...pendingHeader);
      pendingHeader = [];
    }
    toAppend.push(line);
    existingPatterns.add(line.trim());
  }

  // Always ensure git points at this file.
  const needsConfigUpdate = configured == null || expandPath(configured) !== ignorePath;

  if (toAppend.length === 0 && !needsConfigUpdate) {
    console.log(`✅ Already set up — ${ignorePath} has all patterns and git is configured.`);
    return;
  }

  // Build the new file content. Brand-new files get a header; existing files
  // keep their content and gain the new patterns after a blank-line separator.
  const finalLines = existingContent.length
    ? [...existingLines, ...(toAppend.length ? [''] : []), ...toAppend]
    : ['# Global gitignore (managed by rubato)', '', ...toAppend];
  const newContent = `${finalLines.join('\n')}\n`;

  if (opts.dryRun) {
    console.log(`🔎 Dry run — no changes written.\n`);
    console.log(`Target file: ${ignorePath}`);
    if (needsConfigUpdate) {
      console.log(`Would run:  git config --global core.excludesFile "${ignorePath}"`);
    }
    if (toAppend.length) {
      console.log(`\nWould append ${toAppend.filter(isPattern).length} pattern(s):`);
      for (const line of toAppend) console.log(`  ${line || '(blank)'}`);
    } else {
      console.log('\nNo new patterns to append.');
    }
    return;
  }

  // Ensure the parent directory exists, then write.
  await $`mkdir -p ${dirname(ignorePath)}`.quiet();
  await Bun.write(ignorePath, newContent);

  if (needsConfigUpdate) {
    await $`git config --global core.excludesFile ${ignorePath}`;
    console.log(`🔧 Configured git: core.excludesFile = ${ignorePath}`);
  }

  if (toAppend.length) {
    console.log(`✅ Added ${toAppend.filter(isPattern).length} pattern(s) to ${ignorePath}`);
  } else {
    console.log(`✅ ${ignorePath} already had every pattern.`);
  }
}

if (import.meta.main)
  main().catch((err) => {
    console.error('❌ Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
