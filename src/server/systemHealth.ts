import { accessSync, constants, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHealthRegistry, type HealthCheck, type HealthReport, type HealthResult } from 'cwip/health';
import { loadApps } from '../lib/apps';
import { APPS_FILE, CONFIG_FILE, ENV_FILE, expandPath, OUTPUTS_DIR, RUBATO_HOME } from '../lib/config';

// System health for the rubato server, built on the shared, framework-agnostic
// cwip/health registry (the same primitive cursedalchemy's System Health console
// uses). Each check is READ-ONLY and reports what it found + how to fix it. Surfaced
// at GET /api/health/system. Keep checks side-effect-free.

/**
 * A filesystem path a health check refers to (e.g. RUBATO_HOME, config.json),
 * surfaced alongside the prose `detail` so the admin UI can render an actionable
 * affordance: open it in the editor, and — for a file that exists — view its
 * contents inline. `exists` is computed at report time so the UI knows when an
 * inline "View" is meaningful (a dir, or a not-yet-created file, only gets "open").
 */
export interface HealthPath {
  label: string;
  path: string;
  kind: 'file' | 'dir';
  exists: boolean;
}

/** A health result enriched with the concrete paths it refers to (rubato superset
 * of cwip's `HealthResult`). */
export interface SystemHealthResult extends HealthResult {
  paths?: HealthPath[];
}

/** The aggregated report, with each result's referenced paths attached. */
export interface SystemHealthReport extends Omit<HealthReport, 'results'> {
  results: SystemHealthResult[];
}

const isWritable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const checkHome = (): HealthResult => {
  const exists = existsSync(RUBATO_HOME);
  const ok = exists && isWritable(RUBATO_HOME);
  return {
    id: 'rubato_home',
    title: 'Rubato home directory',
    category: 'Storage',
    severity: 'error',
    status: ok ? 'ok' : 'error',
    detail: ok
      ? `RUBATO_HOME is present and writable (${RUBATO_HOME}).`
      : exists
        ? `RUBATO_HOME exists but is not writable (${RUBATO_HOME}).`
        : `RUBATO_HOME does not exist yet (${RUBATO_HOME}).`,
    remediation: ok
      ? []
      : [`Create and make it writable: mkdir -p ${RUBATO_HOME}`, 'Or run any rubato command once to provision it.'],
  };
};

const checkConfig = (): HealthResult => {
  const exists = existsSync(CONFIG_FILE);
  return {
    id: 'config_file',
    title: 'Config file',
    category: 'Config',
    severity: 'info',
    status: exists ? 'ok' : 'info',
    detail: exists
      ? `config.json is present (${CONFIG_FILE}).`
      : 'No config.json — zero-config defaults apply. This is fine; config is optional.',
    remediation: exists ? [] : ['Create one with rubato-init, or edit ~/.rubato/config.json directly.'],
  };
};

const checkEnv = (): HealthResult => {
  const exists = existsSync(ENV_FILE);
  return {
    id: 'env_file',
    title: 'Service credentials (.env)',
    category: 'Secrets',
    severity: 'info',
    status: exists ? 'ok' : 'info',
    detail: exists
      ? `~/.rubato/.env is present — service clients can resolve credentials.`
      : 'No ~/.rubato/.env — features that call external services (Jenkins/Quay/LLM/…) stay credential-gated until you add one.',
    remediation: exists ? [] : ['Add ~/.rubato/.env with the keys a service needs (see the per-service docs).'],
  };
};

const checkApps = async (): Promise<HealthResult> => {
  const apps = await loadApps();
  return {
    id: 'apps_registered',
    title: 'Registered apps',
    category: 'Apps',
    severity: 'info',
    status: apps.length ? 'ok' : 'info',
    detail: apps.length ? `${apps.length} app(s) registered.` : 'No apps registered yet.',
    remediation: apps.length
      ? []
      : ['Register apps via the rubato CLI (clone/register), or add entries to ~/.rubato/apps.json.'],
  };
};

const checkOutputDir = async (): Promise<HealthResult> => {
  const outputDir = OUTPUTS_DIR;
  const exists = existsSync(outputDir);
  const status = !exists ? 'info' : isWritable(outputDir) ? 'ok' : 'warn';
  return {
    id: 'output_dir',
    title: 'Output directory',
    category: 'Storage',
    severity: 'warn',
    status,
    detail: !exists
      ? `Output dir isn't created yet (${outputDir}); it's created on first write.`
      : status === 'ok'
        ? `Output dir is writable (${outputDir}).`
        : `Output dir exists but is not writable (${outputDir}).`,
    remediation: status === 'warn' ? [`Fix permissions on ${outputDir}.`] : [],
  };
};

const CHECKS: HealthCheck[] = [checkHome, checkConfig, checkEnv, checkApps, checkOutputDir];

const registry = createHealthRegistry(CHECKS);

// The concrete paths each check refers to, keyed by the check's stable `id`. These
// are the SAME config constants the checks build their `detail` from, hoisted here
// so the UI gets a structured, openable reference rather than parsing prose. This
// map is also the single source of truth for which files are inline-viewable (see
// `readSystemHealthFile`) — there is no other allowlist to keep in sync.
const PATHS_BY_ID: Record<string, Omit<HealthPath, 'exists'>[]> = {
  rubato_home: [{ label: 'RUBATO_HOME', path: RUBATO_HOME, kind: 'dir' }],
  config_file: [{ label: 'config.json', path: CONFIG_FILE, kind: 'file' }],
  env_file: [{ label: '.env', path: ENV_FILE, kind: 'file' }],
  apps_registered: [{ label: 'apps.json', path: APPS_FILE, kind: 'file' }],
  output_dir: [{ label: 'Output directory', path: OUTPUTS_DIR, kind: 'dir' }],
};

/** The set of FILE paths the report surfaces — the allowlist `readSystemHealthFile`
 * reads from, so the inline viewer has no path-traversal surface (only these). */
const viewableFilePaths = (): Set<string> =>
  new Set(
    Object.values(PATHS_BY_ID)
      .flat()
      .filter((p) => p.kind === 'file')
      .map((p) => p.path),
  );

/** Run the rubato system-health registry and return the aggregated report, with
 * each result's referenced paths (and their current existence) attached. */
export const runSystemHealth = async (): Promise<SystemHealthReport> => {
  const report = await registry.run();
  return {
    ...report,
    results: report.results.map((r) => {
      const specs = PATHS_BY_ID[r.id];
      if (!specs) return r;
      return { ...r, paths: specs.map((p) => ({ ...p, exists: existsSync(p.path) })) };
    }),
  };
};

/** Cap a single file we'll return inline to the admin viewer (not a download). */
const MAX_VIEW_BYTES = 2 * 1024 * 1024;

export type SystemHealthFile =
  | { ok: true; name: string; content: string }
  | { ok: false; status: number; error: string };

/**
 * Read one health-surfaced file for the admin "View" affordance. Only the exact
 * file paths in `PATHS_BY_ID` are readable (the request path must match one after
 * tilde-expansion) — so this can serve a secret like `~/.rubato/.env` without
 * opening a general arbitrary-file read. Loopback single-user server; the tight
 * allowlist is the whole guard.
 */
export const readSystemHealthFile = async (requested: string): Promise<SystemHealthFile> => {
  const abs = expandPath(requested);
  if (!viewableFilePaths().has(abs)) return { ok: false, status: 403, error: 'not a viewable system file' };
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { ok: false, status: 404, error: 'not a file' };
    if (info.size > MAX_VIEW_BYTES) return { ok: false, status: 413, error: 'file too large to view inline' };
    return { ok: true, name: basename(abs), content: await readFile(abs, 'utf8') };
  } catch {
    return { ok: false, status: 404, error: 'file not found' };
  }
};
