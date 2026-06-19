/**
 * rubato global config — stored per-machine in ~/.rubato/config.json.
 *
 * This is intentionally outside the repo: every computer hosts a different set
 * of apps, so paths and settings are machine-local and user-editable.
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { $ } from 'bun';
import { expandHome } from 'cwip/node';
import type { AuthConfig } from '../shared/auth';
import type { UiConfig, UiConfigPatch } from '../shared/ui';
import type {
  AiGlobalConfig,
  ArtConfig,
  JenkinsGlobalConfig,
  OpenshiftGlobalConfig,
  ServiceGlobalConfig,
  SplunkGlobalConfig,
} from './appApis';

/** Tilde-expand + resolve a path — cwip's `expandHome`, kept under rubato's name. */
export const expandPath = expandHome;

/**
 * Root for all per-machine rubato state — config.json, apps.json, .env, the runs
 * db, and every generated-file dir below. Defaults to ~/.rubato, but the
 * RUBATO_HOME env var redirects every command's state elsewhere. `rubato-sandbox`
 * uses this to point commands at a throwaway data dir so you can test live without
 * touching your real registry. This is the ONE relocation knob — every rubato dir
 * derives from it, so a machine's whole footprint moves together and nothing
 * scatters to ad-hoc locations.
 */
export const RUBATO_HOME = process.env.RUBATO_HOME
  ? expandPath(process.env.RUBATO_HOME)
  : resolve(homedir(), '.rubato');
export const CONFIG_FILE = resolve(RUBATO_HOME, 'config.json');
export const APPS_FILE = resolve(RUBATO_HOME, 'apps.json');
export const ENV_FILE = resolve(RUBATO_HOME, '.env');
/**
 * Where command run outputs + reports are written (the latest run per command,
 * overwritten on the next run; the web UI "Files" tab reads here). Always under
 * RUBATO_HOME — deliberately not configurable, so generated files can't scatter or
 * differ per machine.
 */
export const OUTPUTS_DIR = resolve(RUBATO_HOME, 'outputs');
/** Where discoverable custom `*.ts` scripts live (the file half of "custom functions"). */
export const SCRIPTS_DIR = resolve(RUBATO_HOME, 'scripts');
/**
 * Where the admin-only "reset from scratch" setup scripts live (the ollama/conda/
 * fooocus/orchestrator/SES/EC2/Cloudflare + rubato/ca provisioning scripts). Under
 * RUBATO_HOME so they're per-machine and OUTSIDE git — the repo ships sanitized
 * templates that are seeded here; the editable copies (which may hold machine- and
 * account-specific values) never get committed. Only the Admin panel surfaces them.
 */
export const SETUP_SCRIPTS_DIR = resolve(RUBATO_HOME, 'setup-scripts');
/**
 * Where locally-generated art/image assets are written, one subdir per app
 * (`generated-assets/<appId>/art_asset_*.png`). Under RUBATO_HOME (not the repo's
 * `public/`) so assets are machine-local runtime state, served via a GET route —
 * never committed and present in prod the same way as dev.
 */
export const GENERATED_ASSETS_DIR = resolve(RUBATO_HOME, 'generated-assets');
/**
 * Where the test runner writes structured run reports (cwip `writeReportFiles`):
 * `<id>.json/.html/.txt` + a `<id>-artifacts/` dir. The Test Reports page reads
 * here. Under RUBATO_HOME but OUTSIDE any per-run isolated home, so a real serve
 * can show reports a test process produced.
 */
export const TEST_REPORTS_DIR = process.env.RUBATO_TEST_REPORTS_DIR
  ? expandPath(process.env.RUBATO_TEST_REPORTS_DIR)
  : resolve(RUBATO_HOME, 'test-reports');

export interface RubatoConfig {
  /** Root directories scanned for app repos (expanded, absolute). */
  codeDirs: string[];
  /** Command used to open an app (e.g. "code", "cursor", "open"). */
  editor: string;
  /**
   * Directory names pruned during scanning (in addition to built-in ones like
   * node_modules). Use this to keep archives/backups out of the registry,
   * e.g. ["backupsCode", "read", "archive"].
   */
  ignore: string[];
  /** Global Jenkins settings/conventions (per-app config overrides these). */
  jenkins?: JenkinsGlobalConfig;
  /** Global Quay settings (base URL; per-app config overrides). */
  quay?: ServiceGlobalConfig;
  /** Global GitLab settings (base URL; per-app config overrides). */
  gitlab?: ServiceGlobalConfig;
  /** Global Splunk query-builder settings/conventions (per-app config overrides these). */
  splunk?: SplunkGlobalConfig;
  /** Global Datadog settings (base URL; defaults to https://api.datadoghq.com). */
  datadog?: ServiceGlobalConfig;
  /** Global Dynatrace settings (environment base URL). */
  dynatrace?: ServiceGlobalConfig;
  /** Global GitHub settings (base URL; defaults to https://api.github.com — set for GHE). */
  github?: ServiceGlobalConfig;
  /** Global Rancher settings (base URL of the Rancher server). */
  rancher?: ServiceGlobalConfig;
  /** Global OpenShift/k8s settings (base URL of the cluster API server). */
  openshift?: OpenshiftGlobalConfig;
  /** Global Harness settings (base URL; defaults to https://app.harness.io). */
  harness?: ServiceGlobalConfig;
  /** Global AI / "ask about your repo" settings (per-app `ai` overrides these). */
  ai?: AiGlobalConfig;
  /** Local art/image generation settings (diffusion backend, output). */
  art?: ArtConfig;
  /** Web-UI page enablement + Admin gate (see src/shared/ui.ts). */
  ui?: UiConfig;
  /** Custom scripts + pipelines settings (the run dir, discovered scripts). */
  automations?: AutomationsConfig;
  /** Session/JWT fetching against an environment's IdP (see src/shared/auth.ts). */
  auth?: AuthConfig;
  /** Settings for the unattended task-queue workflows (Orchestration page). */
  orchestration?: OrchestrationConfig;
  /** Cross-app sync with a cursedalchemy deployment (pull tasks, push fleet data). */
  caSync?: CaSyncConfig;
  /** Named SSH server connections for quick prod-server access (localhost only). */
  servers?: ServersConfig;
}

/**
 * ca → rubato bridge: pull owner-authored tasks from a cursedalchemy deployment
 * into the taskq queue and push orchestration data back. The base URL + host id
 * may live here; the API KEY is env-only (CA_SYNC_API_KEY in ~/.rubato/.env), and
 * env (CA_SYNC_URL / CA_SYNC_HOST_ID) overrides these. See server/caSync.
 */
export interface CaSyncConfig {
  /** Disable the sync even when a URL + key are configured. Default: enabled. */
  enabled?: boolean;
  /** cursedalchemy origin (no trailing slash, no /api). Env CA_SYNC_URL overrides. */
  url?: string;
  /** Stable id for this rubato machine. Env CA_SYNC_HOST_ID overrides; default hostname. */
  hostId?: string;
  /** Seconds between task pulls (min 10, default 60). */
  pullSeconds?: number;
  /** Seconds between data pushes (min 10, default 60). */
  pushSeconds?: number;
}

/** SSH connection config for a named remote server. */
export interface SshServerConfig {
  /** Display label shown in the UI (defaults to host). */
  label?: string;
  /** SSH host (e.g. "myapp.example.com" or "192.168.1.10"). */
  host: string;
  /** SSH user (defaults to current OS user). */
  user?: string;
  /** SSH port (default 22). */
  port?: number;
  /** Path to private key (e.g. "~/.ssh/id_ed25519"). */
  keyPath?: string;
  /** Additional SSH flags (e.g. ["-o", "StrictHostKeyChecking=no"]). */
  extraArgs?: string[];
}

/** Named server connection profiles. */
export interface ServersConfig {
  ssh?: SshServerConfig[];
}

/**
 * Settings for the unattended "drain the task queue" workflows surfaced on the
 * Orchestration page. The notes dir is machine-specific (it lives OUTSIDE
 * `~/.rubato`, in the user's workspace), so it's the one configurable path —
 * `RUBATO_NOTES_DIR` env overrides this, and an absent value derives a default.
 */
export interface OrchestrationConfig {
  /**
   * Directory holding the workflow control files (TASKS.md, Tasks_Completed.md,
   * orchestration/runs/*.jsonl). Default: `~/code/workspaces/___Agent_Workspace`.
   */
  notesDir?: string;
}

/** Settings for custom TS scripts + pipelines. */
export interface AutomationsConfig {
  /** Default per-script timeout in ms (file scripts), default 30_000. */
  timeout?: number;
}

/** GUI/code editors we prefer, in order, when none is configured. */
const EDITOR_CANDIDATES = ['cursor', 'code', 'subl', 'webstorm', 'idea'];

export function detectEditor(): string {
  for (const ed of EDITOR_CANDIDATES) {
    if (Bun.which(ed)) return ed;
  }
  if (process.platform === 'darwin') return 'open';
  if (process.platform === 'win32') return 'start';
  // Linux/other: prefer a generic opener that actually exists on this machine.
  for (const opener of ['xdg-open', 'gnome-open', 'kde-open']) {
    if (Bun.which(opener)) return opener;
  }
  return 'xdg-open'; // last resort; the user can override `editor` in config.json
}

/**
 * Normalize the configured scan root(s) into an expanded, de-duplicated list.
 * Accepts the canonical `codeDirs` array and the legacy `codeDir` string
 * (shorthand for a single root); when both are present they're unioned. Empty
 * values are dropped, and it falls back to ["~/code"] when nothing is set.
 */
export function normalizeCodeDirs(raw: { codeDir?: unknown; codeDirs?: unknown }): string[] {
  const list: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim() !== '') list.push(v);
  };
  add(raw.codeDir);
  if (Array.isArray(raw.codeDirs)) raw.codeDirs.forEach(add);
  else add(raw.codeDirs);
  const unique = [...new Set(list.map(expandPath))];
  return unique.length ? unique : [expandPath('~/code')];
}

// Parsed config is reused across calls and only re-read when the file changes
// (keyed on mtime+size), so repeated loadConfig() calls in a request don't
// re-read + re-parse + re-detect the editor. saveConfig clears it; a hand/CLI
// edit changes the mtime and is picked up automatically.
let configCache: { mtimeMs: number; size: number; value: RubatoConfig } | null = null;

/** Drop the in-process config cache (after an out-of-band write, or in tests). */
export function clearConfigCache(): void {
  configCache = null;
}

/** Load config, creating a sensible default file on first run. */
export async function loadConfig(): Promise<RubatoConfig> {
  let st: { mtimeMs: number; size: number } | null = null;
  try {
    st = await stat(CONFIG_FILE);
  } catch {
    st = null; // missing → fall through to default creation
  }
  if (st) {
    if (configCache && configCache.mtimeMs === st.mtimeMs && configCache.size === st.size) {
      return { ...configCache.value }; // shallow copy: callers may reassign top-level keys
    }
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Partial<RubatoConfig> & { codeDir?: unknown };
    const value: RubatoConfig = {
      codeDirs: normalizeCodeDirs(raw),
      editor: raw.editor || detectEditor(),
      ignore: raw.ignore ?? [],
      jenkins: raw.jenkins,
      quay: raw.quay,
      gitlab: raw.gitlab,
      splunk: raw.splunk,
      datadog: raw.datadog,
      dynatrace: raw.dynatrace,
      github: raw.github,
      rancher: raw.rancher,
      harness: raw.harness,
      ai: raw.ai,
      art: raw.art,
      ui: raw.ui,
      // Pick only known fields (don't spread) so a removed knob left in an old
      // config.json — e.g. a stale `automations.scriptsDir` — is dropped on load
      // and never re-written back by a later saveConfig.
      automations: raw.automations?.timeout != null ? { timeout: raw.automations.timeout } : undefined,
      orchestration: raw.orchestration,
      caSync: raw.caSync,
      servers: raw.servers,
    };
    configCache = { mtimeMs: st.mtimeMs, size: st.size, value };
    return { ...value };
  }
  const cfg: RubatoConfig = {
    codeDirs: [expandPath('~/code')],
    editor: detectEditor(),
    ignore: [],
  };
  await saveConfig(cfg);
  return cfg;
}

export async function saveConfig(cfg: RubatoConfig): Promise<void> {
  await $`mkdir -p ${RUBATO_HOME}`.quiet();
  await Bun.write(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
  clearConfigCache();
}

/**
 * Merge a UI-toggle patch into config and persist it. Page toggles merge field by
 * field (so flipping one page doesn't drop the others); `admin` replaces when
 * present. Returns the resulting `ui` block. Used by the Admin page (`POST /api/ui`).
 */
export async function setUiConfig(patch: UiConfigPatch): Promise<UiConfig> {
  const cfg = await loadConfig();
  const ui: UiConfig = { ...cfg.ui };
  if (patch.pages) ui.pages = { ...ui.pages, ...patch.pages };
  if (patch.admin !== undefined) ui.admin = patch.admin;
  cfg.ui = ui;
  await saveConfig(cfg);
  return ui;
}
