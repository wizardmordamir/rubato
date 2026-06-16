#!/usr/bin/env bun
/**
 * sandbox  (installed as `rubato-sandbox`)
 *
 * A throwaway playground for dogfooding rubato commands without touching your
 * real registry. It scaffolds a handful of fake git-repo "apps" into a temp
 * area and points all of rubato's state (config.json, apps.json, .env, runs db)
 * at a sandbox `.rubato/` via the RUBATO_HOME env var — so `goto`, `gotab`,
 * `rubato-scan`, `rubato-serve`, etc. all operate on the sandbox in isolation.
 *
 * Typical loop:
 *   rubato-sandbox up        # scaffold fake apps + scan them into the registry
 *   rubato-sandbox shell     # drop into an isolated subshell; try commands live
 *   ...experiment, edit code, re-run...
 *   rubato-sandbox down      # delete the sandbox when you're done
 *
 * The sandbox lives at $RUBATO_SANDBOX (default <tmp>/rubato-sandbox) — always
 * OUTSIDE your real codeDirs, so a real `rubato-scan` never picks up fake apps.
 *
 * Usage:
 *   rubato-sandbox up [--apps a,b,group/c] [--force]
 *   rubato-sandbox shell
 *   rubato-sandbox run <command> [args...]
 *   rubato-sandbox status
 *   rubato-sandbox down
 *   rubato-sandbox reset            # down + up
 */

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { $ } from 'bun';

const REPO_ROOT = resolve(import.meta.dir, '../..');

/** Fake apps scaffolded by default — a mix of root-level and grouped repos. */
export const DEFAULT_APPS = ['api', 'web', 'cli', 'services/auth', 'services/billing'];

/** A couple of preset aliases so `goto <alias>` works right after `up`. */
const DEMO_ALIASES: Record<string, string[]> = {
  api: ['backend'],
  auth: ['login'],
};

export interface SandboxPaths {
  root: string;
  code: string;
  rubato: string;
  shellDir: string;
}

/** Resolve the sandbox location from env (RUBATO_SANDBOX) or a temp-dir default. */
export function resolveSandboxDir(env: Record<string, string | undefined>): string {
  const override = env.RUBATO_SANDBOX?.trim();
  return override ? resolve(override) : resolve(tmpdir(), 'rubato-sandbox');
}

export function sandboxPaths(root: string): SandboxPaths {
  return {
    root,
    code: resolve(root, 'code'),
    rubato: resolve(root, '.rubato'),
    shellDir: resolve(root, 'shell'),
  };
}

/** Parse `--apps a,b,group/c` into a clean spec list, or fall back to defaults. */
export function parseAppSpecs(arg: string | undefined): string[] {
  if (!arg) return DEFAULT_APPS;
  const specs = arg
    .split(',')
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return specs.length ? specs : DEFAULT_APPS;
}

/** The zsh rc that loads your normal config, then isolates + labels the shell. */
export function buildZshRc(p: SandboxPaths): string {
  return [
    '# rubato sandbox shell (generated). Your normal zsh config still loads.',
    'ZDOTDIR="$HOME"', // restore so the rest of the session behaves normally
    '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"',
    `export RUBATO_HOME=${shq(p.rubato)}`,
    `export RUBATO_SANDBOX=${shq(p.root)}`,
    // Re-source freshly-generated functions so the sandbox tests THIS checkout.
    `[ -f ${shq(resolve(p.shellDir, 'aliases.sh'))} ] && source ${shq(resolve(p.shellDir, 'aliases.sh'))}`,
    'PROMPT="%F{magenta}(rubato-sandbox)%f ${PROMPT}"',
    '',
  ].join('\n');
}

/** The bash rc equivalent. */
export function buildBashRc(p: SandboxPaths): string {
  return [
    '# rubato sandbox shell (generated). Your normal bash config still loads.',
    '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"',
    `export RUBATO_HOME=${shq(p.rubato)}`,
    `export RUBATO_SANDBOX=${shq(p.root)}`,
    `[ -f ${shq(resolve(p.shellDir, 'aliases.sh'))} ] && source ${shq(resolve(p.shellDir, 'aliases.sh'))}`,
    'export PS1="(rubato-sandbox) $PS1"',
    '',
  ].join('\n');
}

/** Single-quote a string for safe embedding in shell. */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Env that redirects a child rubato command at the sandbox state dir. */
function sandboxEnv(p: SandboxPaths): Record<string, string> {
  return { ...process.env, RUBATO_HOME: p.rubato, RUBATO_SANDBOX: p.root } as Record<string, string>;
}

/** Create one fake git-repo app with a remote + package.json so scans resolve it. */
export async function scaffoldApp(codeDir: string, spec: string): Promise<void> {
  const dir = resolve(codeDir, spec);
  const name = basename(spec);
  await $`mkdir -p ${dir}`.quiet();
  await $`git -C ${dir} init -q`.quiet();
  await $`git -C ${dir} remote add origin git@github.com:sandbox/${name}.git`.nothrow().quiet();
  // `cli` is left without a package.json to exercise the dirName fallback.
  if (name !== 'cli') {
    await Bun.write(
      resolve(dir, 'package.json'),
      `${JSON.stringify({ name: `@sandbox/${name}`, version: '0.0.0' }, null, 2)}\n`,
    );
  }
  await Bun.write(resolve(dir, 'README.md'), `# ${name}\n\nScaffolded sandbox app.\n`);
}

export interface ProvisionOptions {
  /** App specs to scaffold (default DEFAULT_APPS). */
  apps?: string[];
  /** Extra keys merged into the generated config.json (e.g. service baseUrls). */
  config?: Record<string, unknown>;
  /** Build apps.json by running the real scan (default true). */
  scan?: boolean;
  /** Add the preset demo aliases (default true). */
  demoAliases?: boolean;
}

/**
 * Scaffold fake git-repo apps + write config.json + (optionally) scan them into
 * apps.json. The reusable core of `up()`, shared by the sandbox CLI, integration
 * tests, and the e2e setup so they all seed a home the same way.
 */
export async function provisionSandbox(p: SandboxPaths, opts: ProvisionOptions = {}): Promise<void> {
  const specs = opts.apps ?? DEFAULT_APPS;
  await $`mkdir -p ${p.code} ${p.rubato}`.quiet();
  for (const spec of specs) await scaffoldApp(p.code, spec);

  // Sandbox config: codeDir is the sandbox; editor=echo keeps `gotab` harmless.
  const config = { codeDirs: [p.code], editor: 'echo', ignore: [], ...opts.config };
  await Bun.write(resolve(p.rubato, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

  // Populate apps.json by running the REAL scan against the sandbox state dir.
  if (opts.scan !== false) await runScript('src/scripts/scan-apps.ts', [], p);
  if (opts.demoAliases !== false) await addDemoAliases(p);
}

async function up(args: string[]): Promise<void> {
  const p = sandboxPaths(resolveSandboxDir(process.env));
  const force = args.includes('--force');
  const specs = parseAppSpecs(getOpt(args, 'apps'));

  if ((await Bun.file(resolve(p.rubato, 'config.json')).exists()) && !force) {
    console.log(`Sandbox already exists at ${p.root}. Use --force to rebuild, or 'rubato-sandbox reset'.`);
    return;
  }
  if (force) await rm(p.root, { recursive: true, force: true });

  console.log(`Scaffolding ${specs.length} apps into ${p.code} ...`);
  await provisionSandbox(p, { apps: specs });

  console.log(`\n✅ Sandbox ready at ${p.root}`);
  console.log('   Try it:  rubato-sandbox shell   (then: rubato list, goto backend, rubato-scan, ...)');
  console.log('   Tear down: rubato-sandbox down');
}

/** Add preset aliases to the freshly-scanned registry so matching is demoable. */
async function addDemoAliases(p: SandboxPaths): Promise<void> {
  const appsFile = Bun.file(resolve(p.rubato, 'apps.json'));
  if (!(await appsFile.exists())) return;
  const apps = (await appsFile.json()) as Array<{ dirName: string; aliases?: string[] }>;
  for (const app of apps) {
    const extra = DEMO_ALIASES[app.dirName];
    if (extra) app.aliases = [...new Set([...(app.aliases ?? []), ...extra])];
  }
  await Bun.write(appsFile, `${JSON.stringify(apps, null, 2)}\n`);
}

/** Generate sandbox shell functions pointing at THIS checkout's scripts. */
async function generateAliases(p: SandboxPaths): Promise<void> {
  await $`mkdir -p ${p.shellDir}`.quiet();
  const out = await $`bun ${resolve(REPO_ROOT, 'src/scripts/setup-aliases.ts')} --print`.quiet().text();
  await Bun.write(resolve(p.shellDir, 'aliases.sh'), out);
}

async function shell(): Promise<void> {
  const p = sandboxPaths(resolveSandboxDir(process.env));
  if (!(await Bun.file(resolve(p.rubato, 'config.json')).exists())) {
    console.error("No sandbox yet — run 'rubato-sandbox up' first.");
    process.exit(1);
  }
  await generateAliases(p); // refresh each time so the shell tests current code

  const shellPath = process.env.SHELL || '/bin/zsh';
  const shellName = basename(shellPath);
  const env = sandboxEnv(p);

  console.log(`Entering rubato sandbox (${p.root}). Commands use the sandbox registry. Type 'exit' to leave.\n`);

  let proc: ReturnType<typeof Bun.spawn>;
  if (shellName.includes('zsh')) {
    await Bun.write(resolve(p.shellDir, '.zshrc'), buildZshRc(p));
    proc = Bun.spawn([shellPath, '-i'], {
      env: { ...env, ZDOTDIR: p.shellDir },
      stdio: ['inherit', 'inherit', 'inherit'],
    });
  } else if (shellName.includes('bash')) {
    const rc = resolve(p.shellDir, 'bashrc');
    await Bun.write(rc, buildBashRc(p));
    proc = Bun.spawn([shellPath, '--rcfile', rc, '-i'], { env, stdio: ['inherit', 'inherit', 'inherit'] });
  } else {
    // Unknown shell: isolate via env only (no prompt label / function refresh).
    proc = Bun.spawn([shellPath, '-i'], { env, stdio: ['inherit', 'inherit', 'inherit'] });
  }
  const code = await proc.exited;
  console.log('\nLeft rubato sandbox.');
  process.exit(code ?? 0);
}

/** Run a script from this repo with the sandbox env applied. */
async function runScript(relPath: string, args: string[], p: SandboxPaths): Promise<number> {
  const proc = Bun.spawn(['bun', resolve(REPO_ROOT, relPath), ...args], {
    env: sandboxEnv(p),
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return (await proc.exited) ?? 0;
}

async function run(args: string[]): Promise<void> {
  const p = sandboxPaths(resolveSandboxDir(process.env));
  if (!args.length) {
    console.error('Usage: rubato-sandbox run <command> [args...]');
    process.exit(1);
  }
  // Route through the umbrella so any registered command name works.
  const code = await runScript('src/index.ts', args, p);
  if (['goto', 'gotab'].includes(args[0])) {
    console.error("\n(note: 'goto' can't move your shell from here — use 'rubato-sandbox shell' for that.)");
  }
  process.exit(code);
}

async function status(): Promise<void> {
  const p = sandboxPaths(resolveSandboxDir(process.env));
  const exists = await Bun.file(resolve(p.rubato, 'config.json')).exists();
  console.log(`Sandbox dir:   ${p.root}`);
  console.log(`Exists:        ${exists ? 'yes' : "no — run 'rubato-sandbox up'"}`);
  if (!exists) return;
  const appsFile = Bun.file(resolve(p.rubato, 'apps.json'));
  if (await appsFile.exists()) {
    const apps = (await appsFile.json()) as Array<{ name: string; group: string | null; aliases?: string[] }>;
    console.log(`Registry:      ${apps.length} apps`);
    for (const a of apps) {
      const grp = a.group ? `${a.group}/` : '';
      const al = a.aliases?.length ? `  (aliases: ${a.aliases.join(', ')})` : '';
      console.log(`  - ${grp}${a.name}${al}`);
    }
  }
  const active = process.env.RUBATO_HOME && resolve(process.env.RUBATO_HOME) === p.rubato;
  console.log(`Active here:   ${active ? 'yes (RUBATO_HOME points at sandbox)' : "no (use 'rubato-sandbox shell')"}`);
}

async function down(): Promise<void> {
  const p = sandboxPaths(resolveSandboxDir(process.env));
  // Safety: only ever remove a path that looks like a sandbox.
  if (!p.root.includes('rubato-sandbox')) {
    console.error(`Refusing to delete ${p.root} — RUBATO_SANDBOX must contain "rubato-sandbox".`);
    process.exit(1);
  }
  if (!(await Bun.file(resolve(p.rubato, 'config.json')).exists())) {
    console.log(`Nothing to remove at ${p.root}.`);
    return;
  }
  await rm(p.root, { recursive: true, force: true });
  console.log(`🧹 Removed sandbox ${p.root}`);
}

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

function help(): void {
  console.log(
    [
      'rubato-sandbox — isolated playground for trying rubato commands',
      '',
      'Commands:',
      '  up [--apps a,b,group/c] [--force]   scaffold fake apps + scan them in',
      '  shell                               enter an isolated subshell to try commands',
      '  run <command> [args...]             run one command against the sandbox',
      '  status                              show the sandbox location + registry',
      '  down                                delete the sandbox',
      '  reset                               down + up',
      '',
      'The sandbox lives at $RUBATO_SANDBOX (default <tmp>/rubato-sandbox) and never',
      'touches your real ~/.rubato registry.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'up':
      return up(args);
    case 'shell':
      return shell();
    case 'run':
      return run(args);
    case 'status':
    case undefined:
      return status();
    case 'down':
    case 'clean':
      return down();
    case 'reset':
      await down();
      return up(['--force', ...args]);
    case 'help':
    case '-h':
    case '--help':
      return help();
    default:
      console.error(`unknown subcommand: ${cmd}\n`);
      help();
      process.exit(1);
  }
}

// Only run the CLI when executed directly — importing it (e.g. for `scaffoldApp`
// / `provisionSandbox` in tests) must not trigger the command dispatch.
if (import.meta.main) {
  main().catch((err) => {
    console.error('❌ Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
