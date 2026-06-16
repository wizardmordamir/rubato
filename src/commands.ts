/**
 * Single source of truth for rubato's commands.
 *
 * Each entry maps a memorable shell command name to the TypeScript script that
 * implements it. Two consumers read this list:
 *   - `scripts/setup-aliases.ts` generates a shell function per command into
 *     ~/.rubato-scripts/aliases.sh, sourced from the user's shell rc.
 *   - `index.ts` powers the `rubato` umbrella command (`rubato list` / `rubato <name>`).
 *
 * To add a command: drop a script in src/scripts/, add an entry here, and
 * re-run `rubato-setup`. Optional `args`/`flags`/`examples` drive the web UI's
 * run form (see CommandMeta in src/shared/types.ts) — commands without them get
 * a plain freeform args field.
 */

import type { CommandMeta } from './shared/types';

export type CommandKind = 'plain' | 'cd';

export interface CommandDef extends CommandMeta {
  /** Shell function name the user types, e.g. "globalgitignore". */
  name: string;
  /** Script path relative to the repo root. */
  script: string;
  /** One-line summary shown by `rubato list`. */
  description: string;
  /**
   * "plain" — run the script and stream its output.
   * "cd"    — treat the script's stdout as a directory path and cd the parent
   *           shell into it. Only works because the generated wrapper is a
   *           sourced shell function, not a subprocess (a subprocess can't
   *           change its parent's working directory).
   */
  kind: CommandKind;
  /**
   * Whether the CLI wrapper tees this command's output to the output dir (and
   * records it). Defaults to true for `plain` commands. Set false for
   * long-running or interactive-TTY commands (e.g. the server, the sandbox
   * subshell) that must keep the real terminal. `cd` commands never capture
   * (their stdout is a path the shell consumes).
   */
  capture?: boolean;
}

export const COMMANDS: CommandDef[] = [
  {
    name: 'globalgitignore',
    script: 'src/scripts/setup-global-gitignore.ts',
    description: "Configure git's global ignore file and merge curated patterns.",
    kind: 'plain',
    args: [{ name: 'patterns…', description: 'Extra glob patterns to also ignore', example: '.vscode/ build/ *.log' }],
    flags: [
      { flag: '--print', description: 'Print the default template and exit' },
      { flag: '--dry-run', description: 'Preview the changes without writing' },
      {
        flag: '--path',
        description: 'Use a specific global ignore file',
        takesValue: true,
        example: '~/.gitignore_global',
      },
    ],
    examples: [
      { args: '', note: 'set up + merge the default template' },
      { args: '.vscode/', note: 'also ignore .vscode this run' },
      { args: '--dry-run' },
    ],
  },
  {
    name: 'rubato-setup',
    script: 'src/scripts/setup-aliases.ts',
    description: '(Re)generate rubato shell commands and wire them into your shell rc.',
    kind: 'plain',
    flags: [
      { flag: '--dry-run', description: 'Preview, write nothing' },
      { flag: '--print', description: 'Dump the generated aliases.sh' },
      { flag: '--rc', description: 'Target a specific shell rc file', takesValue: true, example: '~/.zshrc' },
    ],
    examples: [{ args: '' }, { args: '--dry-run' }],
  },
  {
    name: 'rubato-init',
    script: 'src/scripts/init.ts',
    description: 'Scaffold ~/.rubato config + .env for service clients (Jenkins, ...).',
    kind: 'plain',
    flags: [{ flag: '--dry-run', description: 'Show what would change' }],
    examples: [{ args: '' }, { args: '--dry-run' }],
  },
  {
    name: 'rubato-scan',
    script: 'src/scripts/scan-apps.ts',
    description: 'Scan your code dir for git repos and update the app registry.',
    kind: 'plain',
    flags: [{ flag: '--dry-run', description: 'Report counts/conflicts, write nothing' }],
    examples: [{ args: '' }, { args: '--dry-run' }],
  },
  {
    name: 'rubato-sandbox',
    script: 'src/scripts/sandbox.ts',
    description: 'Scaffold an isolated playground of fake apps to test commands live.',
    kind: 'plain',
    capture: false, // spawns an interactive subshell that needs the real TTY
  },
  {
    name: 'goto',
    script: 'src/scripts/goto.ts',
    description: 'cd into an app by name, dir, repo, package name, or alias.',
    kind: 'cd',
    args: [{ name: 'app', description: 'name / alias / dir / repo / package', required: true, example: 'myapp' }],
    examples: [{ args: 'myapp' }],
  },
  {
    name: 'gotab',
    script: 'src/scripts/gotab.ts',
    description: 'Open an app in your editor by name, dir, repo, package name, or alias.',
    kind: 'plain',
    args: [{ name: 'app', description: 'name / alias / dir / repo / package', required: true, example: 'myapp' }],
    examples: [{ args: 'myapp' }],
  },
  {
    name: 'jenk',
    script: 'src/scripts/jenk.ts',
    description: "Show an app's latest Jenkins build (resolve by name/alias; optional env).",
    kind: 'plain',
    args: [
      { name: 'app', description: 'app name or alias', required: true, example: 'myapp' },
      { name: 'env', description: 'environment, e.g. stage (optional)', example: 'stage' },
    ],
    flags: [{ flag: '--success', description: 'latest *successful* build only' }],
    examples: [{ args: 'myapp' }, { args: 'myapp stage' }, { args: 'myapp stage --success' }],
  },
  {
    name: 'deploy',
    script: 'src/scripts/deploy.ts',
    description: 'Trigger a Jenkins deploy for an app or group + env (confirms; --dry-run/--yes).',
    kind: 'plain',
    args: [
      { name: 'app|group', description: 'one app, or a group to deploy all of', required: true, example: 'myapp' },
      { name: 'env', description: 'target environment', required: true, example: 'stage' },
      { name: 'branch', description: 'branch (optional; needed for multibranch)', example: 'main' },
      { name: 'KEY=VALUE…', description: 'build parameters', example: 'FORCE=1 SKIP_TESTS=true' },
    ],
    flags: [
      { flag: '--dry-run', description: 'Resolve job paths, trigger nothing' },
      { flag: '--yes', description: 'Skip the confirmation prompt (required from the web)' },
    ],
    examples: [
      { args: 'myapp stage --dry-run', note: 'preview one app' },
      { args: 'services stage --yes', note: 'deploy the whole group' },
      { args: 'myapp stage main FOO=1 --yes' },
    ],
  },
  {
    name: 'lastdeploy',
    script: 'src/scripts/lastdeploy.ts',
    description: "Show an app's last successful build (branch+commit), or --all for a portfolio view.",
    kind: 'plain',
    args: [
      { name: 'app', description: 'app name or alias (omit with --all)', example: 'myapp' },
      { name: 'env', description: 'environment (optional)', example: 'stage' },
    ],
    flags: [
      { flag: '--all', description: 'all apps: most-recent + last-successful build per app' },
      {
        flag: '--env',
        description: 'with --all, resolve builds for an environment',
        takesValue: true,
        example: 'prod',
      },
      { flag: '--json', description: 'with --all, output JSON' },
      { flag: '--csv', description: 'with --all, output CSV' },
    ],
    examples: [{ args: 'myapp' }, { args: 'myapp stage' }, { args: '--all' }, { args: '--all services --csv' }],
  },
  {
    name: 'jenkbranch',
    script: 'src/scripts/jenkbranch.ts',
    description: 'Show the branch a Jenkins job builds (from its config.xml).',
    kind: 'plain',
    args: [
      { name: 'app', description: 'app name or alias', required: true, example: 'myapp' },
      { name: 'env', description: 'environment (optional)', example: 'stage' },
      { name: 'branch', description: 'branch (optional; for multibranch)', example: 'main' },
    ],
    examples: [{ args: 'myapp' }, { args: 'myapp stage' }],
  },
  {
    name: 'findchanges',
    script: 'src/scripts/findchanges.ts',
    description: 'List apps with uncommitted, unpushed, or stashed changes (optional app|group).',
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'services' }],
    examples: [{ args: '', note: 'all apps' }, { args: 'services' }],
  },
  {
    name: 'appstatus',
    script: 'src/scripts/appstatus.ts',
    description: "Per-app git dashboard: uncommitted + stash counts and every branch's ahead/behind vs origin.",
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'github' }],
    flags: [
      { flag: '--all', description: 'include fully-clean apps too (default: only noteworthy)' },
      { flag: '--fetch', description: 'refresh remote-tracking refs first (otherwise uses last fetch)' },
      { flag: '--json', description: 'output JSON' },
      { flag: '--csv', description: 'output CSV (one row per branch)' },
    ],
    examples: [
      { args: '', note: 'noteworthy apps + all their branches' },
      { args: 'github --fetch' },
      { args: '--all --csv' },
    ],
  },
  {
    name: 'pull',
    script: 'src/scripts/pull.ts',
    description: 'Fast-forward-only pull the latest code across apps (--default updates main/master).',
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'github' }],
    flags: [
      {
        flag: '--default',
        description: "update each repo's default branch (ff in place, no checkout) instead of current",
      },
    ],
    examples: [
      { args: '', note: 'all apps' },
      { args: 'github' },
      { args: '--default', note: 'refresh main everywhere' },
    ],
  },
  {
    name: 'unmerged',
    script: 'src/scripts/unmerged.ts',
    description: 'List local branches with work not in the remote default branch (optional app|group).',
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'github' }],
    examples: [{ args: '', note: 'all apps' }, { args: 'github' }],
  },
  {
    name: 'remote-branches',
    script: 'src/scripts/remote-branches.ts',
    description: 'Inspect origin branches: author, age, ahead/behind (always fetches; filters; --csv/--json).',
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'github' }],
    flags: [
      { flag: '--stale', description: 'only branches untouched N+ days', takesValue: true, example: '90' },
      { flag: '--author', description: 'tip author matches', takesValue: true, example: 'jane' },
      { flag: '--name', description: 'branch name contains this substring', takesValue: true, example: 'release' },
      { flag: '--before', description: 'tip commit older than a date', takesValue: true, example: '2026-01-01' },
      { flag: '--merged', description: 'already merged into the default branch' },
      { flag: '--fetch', description: 'refresh remote-tracking refs first' },
      { flag: '--csv', description: 'emit CSV' },
      { flag: '--json', description: 'emit JSON' },
    ],
    examples: [
      { args: 'github --stale 90', note: 'untouched 90+ days' },
      { args: '--author jane' },
      { args: '--merged --fetch' },
    ],
  },
  {
    name: 'prune-remotes',
    script: 'src/scripts/prune-remotes.ts',
    description: 'Delete origin branches by --merged/--before/--author/--name/--stale (preview unless --yes).',
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'github' }],
    flags: [
      { flag: '--merged', description: 'branches merged into the default branch' },
      { flag: '--before', description: 'tip commit older than a date', takesValue: true, example: '2026-01-01' },
      { flag: '--author', description: 'tip author matches', takesValue: true, example: 'jane' },
      { flag: '--name', description: 'branch name contains this substring', takesValue: true, example: 'spike' },
      { flag: '--stale', description: 'untouched N+ days', takesValue: true, example: '180' },
      { flag: '--fetch', description: 'refresh remote-tracking refs first' },
      { flag: '--yes', description: 'actually delete (otherwise preview only)' },
    ],
    examples: [
      { args: '--merged', note: 'preview merged-in branches' },
      { args: '--merged --yes', note: 'delete them on origin' },
      { args: '--name spike --yes', note: 'delete by name substring' },
      { args: 'github --author jane --stale 180 --yes' },
    ],
  },
  {
    name: 'clearstashes',
    script: 'src/scripts/clearstashes.ts',
    description: 'Drop git stashes across apps (optional app|group; --dry-run).',
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'services' }],
    flags: [{ flag: '--dry-run', description: 'Preview without clearing' }],
    examples: [{ args: '--dry-run' }, { args: 'services' }],
  },
  {
    name: 'delete-branches',
    script: 'src/scripts/deletebranches.ts',
    description: 'Delete merged/gone/all local branches across apps (optional app|group; --dry-run).',
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'services' }],
    flags: [
      { flag: '--merged', description: 'branches merged into the default branch (default)' },
      { flag: '--gone', description: 'branches whose upstream was deleted' },
      { flag: '--all', description: 'every local branch except the default (force; preview first!)' },
      { flag: '--dry-run', description: 'Preview without deleting' },
    ],
    examples: [
      { args: '--dry-run' },
      { args: '--gone' },
      { args: '--all --dry-run', note: 'preview wiping all but default' },
    ],
  },
  {
    name: 'tag',
    script: 'src/scripts/tag.ts',
    description: "Tag each app's HEAD — or its default branch with --default (optional app|group; --push/--dry-run).",
    kind: 'plain',
    args: [
      { name: 'tagText', description: 'the tag to create', required: true, example: 'rel-2026-06' },
      { name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'services' },
    ],
    flags: [
      { flag: '--default', description: 'tag the default branch (main/master) instead of current HEAD' },
      { flag: '--push', description: 'also push the tag to origin' },
      { flag: '--dry-run', description: 'Preview without tagging' },
    ],
    examples: [
      { args: 'rel-2026-06 services' },
      { args: 'rel-2026-06 --default --push', note: 'tag master everywhere & push' },
      { args: 'rel-2026-06 --push --dry-run' },
    ],
  },
  {
    name: 'findterms',
    script: 'src/scripts/findterms.ts',
    description: 'Search a dir tree for expected/unexpected terms; report hits and misses.',
    kind: 'plain',
    args: [{ name: 'dir', description: 'directory to search (default: current dir)', example: './src' }],
    flags: [
      {
        flag: '--expect',
        description: 'comma-separated terms that must appear',
        takesValue: true,
        example: 'TODO,FIXME',
      },
      {
        flag: '--not',
        description: 'comma-separated terms that must NOT appear',
        takesValue: true,
        example: 'console.log,debugger',
      },
      { flag: '--ext', description: 'restrict to a file extension', takesValue: true, example: 'ts' },
      { flag: '--ignore-dir', description: 'skip a directory', takesValue: true, example: 'node_modules' },
      { flag: '--throw', description: 'exit non-zero on a failed expectation' },
    ],
    examples: [{ args: './src --expect TODO,FIXME' }],
  },
  {
    name: 'killports',
    script: 'src/scripts/killports.ts',
    description: 'Kill processes listening on a port or an inclusive port range.',
    kind: 'plain',
    args: [
      { name: 'start', description: 'port (or range start)', required: true, example: '3000' },
      { name: 'end', description: 'range end (optional)', example: '3010' },
    ],
    flags: [{ flag: '--dry-run', description: 'Show what would be killed' }],
    examples: [{ args: '3000' }, { args: '3000 3010' }, { args: '3000 3010 --dry-run' }],
  },
  {
    name: 'doencode',
    script: 'src/scripts/doencode.ts',
    description: 'Encode a dir/file into one portable text file (--seed to encrypt).',
    kind: 'plain',
    args: [{ name: 'path', description: 'directory or file to encode', required: true, example: './my-dir' }],
    flags: [
      {
        flag: '--out',
        description: 'output file (default ./rubato-encoded.txt)',
        takesValue: true,
        example: './rubato-encoded.txt',
      },
      { flag: '--seed', description: 'encrypt with this seed (AES-256-GCM)', takesValue: true, example: 'a secret' },
      { flag: '--max-mb', description: 'skip files larger than N MB', takesValue: true, example: '10' },
    ],
    examples: [{ args: './my-dir' }, { args: "./my-dir --seed 'a secret'" }],
  },
  {
    name: 'dodecode',
    script: 'src/scripts/dodecode.ts',
    description: 'Rebuild files/dirs from a doencode archive (--seed if encrypted).',
    kind: 'plain',
    args: [{ name: 'encodedFile', description: 'a doencode archive', required: true, example: 'rubato-encoded.txt' }],
    flags: [
      { flag: '--out', description: 'output directory (default ./decoded)', takesValue: true, example: './restore' },
      { flag: '--seed', description: 'decryption seed (if encrypted)', takesValue: true, example: 'a secret' },
      { flag: '--force', description: 'overwrite existing files' },
    ],
    examples: [{ args: 'rubato-encoded.txt' }, { args: "backup.txt --out ./restore --seed 'a secret'" }],
  },
  {
    name: 'appall',
    script: 'src/scripts/appall.ts',
    description: 'Cross-app status: latest Jenkins build + Quay image per app (--json/--csv).',
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'services' }],
    flags: [
      { flag: '--env', description: 'filter to an environment', takesValue: true, example: 'stage' },
      { flag: '--json', description: 'output JSON' },
      { flag: '--csv', description: 'output CSV' },
      { flag: '--rich', description: 'with --json, include full joined detail (digest, size, urls)' },
    ],
    examples: [{ args: '' }, { args: 'services --json' }, { args: '--rich --json' }],
  },
  {
    name: 'shalist',
    script: 'src/scripts/shalist.ts',
    description: 'Generate a deploy list (app/version/commit/sha256) per app from live Quay+Jenkins.',
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'services' }],
    flags: [
      { flag: '--env', description: 'resolve the Jenkins build for an environment', takesValue: true, example: 'prod' },
      { flag: '--dates', description: "dated layout: 'app version (M-D H:MM)' with commit: lines" },
      { flag: '--image', description: "single-line image layout: 'app version sha256:...'" },
      { flag: '--out', description: 'write to a file instead of stdout', takesValue: true, example: './shasList.txt' },
    ],
    examples: [{ args: '' }, { args: 'services --out ./shasList.txt' }, { args: '--image' }],
  },
  {
    name: 'verifyshas',
    script: 'src/scripts/verifyshas.ts',
    description: 'Verify a hand-maintained deploy list against live Quay/Git/Jenkins; flag mismatches.',
    kind: 'plain',
    args: [
      { name: 'listFile', description: 'deploy list to verify (default ./shasList.txt)', example: './shasList.txt' },
    ],
    flags: [
      { flag: '--env', description: 'resolve Jenkins builds for an environment', takesValue: true, example: 'prod' },
      { flag: '--json', description: 'output the full JSON report' },
      { flag: '--csv', description: 'output the report as CSV' },
      {
        flag: '--out',
        description: 'also write json+csv report files to a directory',
        takesValue: true,
        example: './out',
      },
    ],
    examples: [{ args: '' }, { args: './shasList.txt --json' }],
  },
  {
    name: 'checkimageshas',
    script: 'src/scripts/checkimageshas.ts',
    description: 'Check that each sha256 image digest in a list exists as a Quay tag.',
    kind: 'plain',
    args: [
      { name: 'listFile', description: 'image-sha list (default ./imageShasList.txt)', example: './imageShasList.txt' },
    ],
    flags: [
      { flag: '--json', description: 'output JSON' },
      { flag: '--csv', description: 'output CSV' },
    ],
    examples: [{ args: '' }, { args: './imageShasList.txt --json' }],
  },
  {
    name: 'scans',
    script: 'src/scripts/scans.ts',
    description: "Download a Jenkins build's artifacts (scans) for an app/env.",
    kind: 'plain',
    args: [
      { name: 'app', description: 'app name or alias', required: true, example: 'myapp' },
      { name: 'env', description: 'environment (optional)', example: 'stage' },
    ],
    flags: [
      { flag: '--build', description: 'specific build number', takesValue: true, example: '42' },
      { flag: '--out', description: 'output directory', takesValue: true, example: './scans' },
    ],
    examples: [{ args: 'myapp' }, { args: 'myapp stage' }],
  },
  {
    name: 'scanvulns',
    script: 'src/scripts/scanvulns.ts',
    description: "Tally a Quay image's security-scan vulnerabilities by severity (per app/group).",
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'services' }],
    flags: [
      {
        flag: '--version',
        description: 'scan a specific image tag (default: latest)',
        takesValue: true,
        example: '1.2.3',
      },
      { flag: '--json', description: 'output JSON' },
      { flag: '--csv', description: 'output CSV' },
    ],
    examples: [{ args: '' }, { args: 'myapp --version 1.2.3' }],
  },
  {
    name: 'startprs',
    script: 'src/scripts/startprs.ts',
    description: 'Open a GitHub PR per app on a pushed feature branch (gh; --dry-run/--yes).',
    kind: 'plain',
    args: [{ name: 'app|group', description: 'narrow to a group or one app (optional)', example: 'services' }],
    flags: [
      { flag: '--title', description: 'PR title', takesValue: true, example: 'Bump deps' },
      { flag: '--base', description: 'base branch', takesValue: true, example: 'main' },
      { flag: '--dry-run', description: 'Preview without creating PRs' },
      { flag: '--yes', description: 'Skip the confirmation prompt (required from the web)' },
    ],
    examples: [{ args: '--dry-run' }, { args: 'services --yes' }],
  },
  {
    name: 'prod-ssh',
    script: 'src/scripts/prod-ssh.ts',
    description: 'Open an SSH connection to a configured prod server (see servers.ssh in config).',
    kind: 'plain',
    capture: false, // interactive TTY; must keep the real terminal
    args: [{ name: 'server', description: 'server label or number (omit when only one is configured)', example: 'prod' }],
    examples: [{ args: '', note: 'auto-connect if one server; menu if multiple' }, { args: 'prod' }],
  },
  {
    name: 'rubato-serve',
    script: 'src/scripts/serve.ts',
    description: 'Start the local web explorer (apps/commands/config) + read API.',
    kind: 'plain',
    capture: false, // long-running server; never exits to flush a capture
    flags: [
      { flag: '--port', description: 'port to listen on (default 4747)', takesValue: true, example: '4747' },
      { flag: '--open', description: 'open the browser' },
    ],
    examples: [{ args: '--open' }],
  },
  {
    name: 'rubato-automate',
    script: 'src/scripts/automate.ts',
    description: 'Run a saved Playwright automation headless (build them in the web UI).',
    kind: 'plain',
    args: [{ name: 'name', description: 'automation id or name', required: true, example: 'scrape-prices' }],
    flags: [
      { flag: '--headed', description: 'show the browser window' },
      { flag: '--list', description: 'list saved automations' },
    ],
    examples: [{ args: '--list' }, { args: 'scrape-prices' }, { args: 'login-and-deploy --headed' }],
  },
  {
    name: 'rubato-pipeline',
    script: 'src/scripts/pipeline.ts',
    description:
      'Run a saved pipeline — chain automations + custom scripts, sharing files + vars (build them in the web UI).',
    kind: 'plain',
    args: [
      { name: 'name', description: 'pipeline id or name', required: true, example: 'report-flow' },
      { name: 'KEY=VALUE…', description: 'supply required variables', example: 'TOKEN=abc SHEET=Q3' },
    ],
    flags: [{ flag: '--list', description: 'list saved pipelines' }],
    examples: [{ args: '--list' }, { args: 'report-flow' }, { args: 'report-flow SHEET=Q3' }],
  },
  {
    name: 'rubato-export',
    script: 'src/scripts/export-automation.ts',
    description: "Export a saved automation as a standalone @playwright/test spec for another app's e2e suite.",
    kind: 'plain',
    args: [{ name: 'name', description: 'automation id or name', required: true, example: 'scrape-prices' }],
    flags: [
      {
        flag: '--out',
        description: 'write to this file (default ./<id>.spec.ts)',
        takesValue: true,
        example: './tests/scrape.spec.ts',
      },
      { flag: '--stdout', description: 'print the spec instead of writing a file' },
      { flag: '--list', description: 'list saved automations' },
    ],
    examples: [
      { args: '--list' },
      { args: 'scrape-prices', note: 'write ./scrape-prices.spec.ts' },
      { args: 'login --out ./e2e/login.spec.ts' },
    ],
  },
  {
    name: 'rubato-ai-setup',
    script: 'src/scripts/ai-setup.ts',
    description: "Stage the local embedding model so semantic/hybrid 'Ask' retrieval works offline.",
    kind: 'plain',
    flags: [
      { flag: '--model', description: 'model id to stage', takesValue: true, example: 'Xenova/all-MiniLM-L6-v2' },
      {
        flag: '--from',
        description: 'copy from a hand-downloaded folder instead of fetching',
        takesValue: true,
        example: './all-MiniLM-L6-v2',
      },
      { flag: '--verify', description: 'check whether the model is already staged' },
    ],
    examples: [{ args: '' }, { args: '--verify' }, { args: '--from ./all-MiniLM-L6-v2' }],
  },
  {
    name: 'rubato-index',
    script: 'src/scripts/ai-index.ts',
    description: "(Re)build the 'Ask' context index for an app (incremental; --force rebuilds).",
    kind: 'plain',
    args: [{ name: 'app', description: 'app name or alias', required: true, example: 'myapp' }],
    flags: [{ flag: '--force', description: 'rebuild from scratch instead of incrementally' }],
    examples: [{ args: 'myapp' }, { args: 'myapp --force' }],
  },
  {
    name: 'rubato-ask',
    script: 'src/scripts/ai-ask.ts',
    description: 'Ask a question about an app from the terminal; the answer streams to stdout.',
    kind: 'plain',
    args: [
      { name: 'app', description: 'app name or alias', required: true, example: 'myapp' },
      { name: 'question…', description: 'the question to ask', required: true, example: 'how does auth work?' },
    ],
    examples: [{ args: 'myapp how does the server route requests?' }],
  },
  {
    name: 'svc',
    script: 'src/scripts/service.ts',
    description: 'Call a configured service API (Datadog/GitHub/Rancher/…) and print JSON.',
    kind: 'plain',
    args: [
      { name: 'service', description: 'service name (omit to list all)', example: 'datadog' },
      { name: 'operation', description: "operation key (omit to list a service's ops)", example: 'searchLogs' },
      { name: 'params…', description: 'operation params as key=value', example: 'query=status:error from=now-1h' },
    ],
    examples: [
      { args: '', note: 'list services + operations' },
      { args: 'github getRepo repo=owner/my-app' },
      { args: 'datadog searchLogs query=service:api from=now-1h' },
    ],
  },
  {
    name: 'watchdog',
    script: 'src/scripts/watchdog.ts',
    description: 'Control + observe the unattended task-queue drainer and its launchd watchdog.',
    kind: 'plain',
    args: [
      {
        name: 'subcommand',
        description:
          'status (default) | interval | jobs | thinking | fast | pause | resume | start | stop | logs | tail | files | commands',
        example: 'status',
      },
      { name: 'value', description: 'subcommand argument (seconds / n / level / on|off / log key)', example: '300' },
    ],
    flags: [{ flag: '--json', description: 'Machine-readable snapshot (status only)' }],
    examples: [
      { args: '', note: 'live status: state, instances, next check, problems' },
      { args: 'interval 300', note: 'set the watchdog tick interval to 5 minutes' },
      { args: 'jobs 3', note: 'run up to 3 concurrent instances on the next drain' },
      { args: 'thinking high', note: 'deeper extended-thinking budget per run' },
      { args: 'fast on', note: 'request /fast faster-output mode' },
      { args: 'pause' },
      { args: 'start 2', note: 'start a drain now with 2 workers' },
      { args: 'tail watchdog-log 50' },
    ],
  },
];

/**
 * Default tech tags per command name — what the command "involves" (git, jenkins,
 * quay, …), shown as chips on the Commands page. A command's own `tags` (if set in
 * its registry entry) overrides this map; everything else falls back here, so the
 * common git/deploy commands are tagged without bloating the registry entries.
 */
const COMMAND_TAGS: Record<string, string[]> = {
  jenk: ['deploy', 'jenkins'],
  deploy: ['deploy', 'jenkins'],
  lastdeploy: ['deploy', 'jenkins'],
  jenkbranch: ['deploy', 'jenkins'],
  scans: ['jenkins'],
  appall: ['git', 'jenkins', 'quay'],
  shalist: ['git', 'jenkins', 'quay'],
  verifyshas: ['git', 'jenkins', 'quay'],
  checkimageshas: ['quay'],
  scanvulns: ['quay'],
  findchanges: ['git'],
  appstatus: ['git'],
  pull: ['git'],
  unmerged: ['git'],
  'remote-branches': ['git'],
  'prune-remotes': ['git'],
  clearstashes: ['git'],
  'delete-branches': ['git'],
  tag: ['git'],
  startprs: ['git'],
  'prod-ssh': ['ssh', 'prod'],
};

/** The default tags for a command name (undefined when none), for the Commands UI. */
export const commandTags = (name: string): string[] | undefined => COMMAND_TAGS[name];
