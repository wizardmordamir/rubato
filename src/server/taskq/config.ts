/**
 * Orchestrator config — `~/.taskq/config.json` (JOBS, default model, fleet tiers,
 * repo roots). All optional; sane defaults derived from the home dir. The drain
 * entrypoint reads this to size the worker pool + tier the fleet.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { taskqHome } from 'cwip/taskq';

/** Worker model aliases + thinking levels the config accepts. */
export const CONFIG_MODEL_ALIASES = ['opus', 'opus-1m', 'sonnet', 'haiku', 'fable'];
export const CONFIG_THINK_LEVELS = ['off', 'low', 'medium', 'high', 'max'];

/** One fleet tier: a pool of workers that only claims its model aliases. */
export interface FleetTier {
  models: string[];
  jobs: number;
}

export interface TaskqConfig {
  /** Flat worker count (used when no fleet tiers are set). */
  jobs: number;
  /** Default worker model alias when a task doesn't pin one. */
  model: string;
  /** Default thinking level when a task doesn't pin one. */
  think?: string;
  /** Default `/fast` mode for workers. */
  fast?: boolean;
  /** Optional fleet: distinct per-model worker pools (overrides `jobs`). */
  fleet?: FleetTier[];
  /** Lease TTL ms (worker must heartbeat within this). */
  leaseTtlMs: number;
  /** repo alias → absolute checkout root. */
  repos: Record<string, string>;
  /** Opt-in auto-triage / epic decomposition (off by default — conservative). */
  triage?: { enabled: boolean };
  /** Background `/usage` telemetry poll interval, minutes (0 = off, manual only). */
  usagePollMinutes: number;
  /** Background `ccusage` cost poll interval, minutes (0 = off, manual only). */
  usageCostPollMinutes: number;
}

/** A user-supplied config patch (only the editable knobs). */
export type TaskqConfigPatch = Partial<
  Pick<
    TaskqConfig,
    'jobs' | 'model' | 'think' | 'fast' | 'fleet' | 'leaseTtlMs' | 'usagePollMinutes' | 'usageCostPollMinutes'
  > & { triageEnabled: boolean }
>;

/** Max accepted poll interval (minutes) — 24h. 0 means "off / manual only". */
const MAX_POLL_MINUTES = 1440;

function defaults(): TaskqConfig {
  const gh = join(homedir(), 'code', 'github');
  return {
    jobs: 2,
    model: 'opus',
    leaseTtlMs: 15 * 60_000,
    usagePollMinutes: 5,
    usageCostPollMinutes: 30,
    repos: {
      ca: join(gh, 'cursedalchemy'),
      ru: join(gh, 'rubato'),
      cwip: join(gh, 'cwip'),
    },
  };
}

/** Load + merge config over defaults (missing file ⇒ defaults). */
export function loadTaskqConfig(): TaskqConfig {
  const base = defaults();
  try {
    const raw = JSON.parse(readFileSync(join(taskqHome(), 'config.json'), 'utf8')) as Partial<TaskqConfig>;
    return {
      ...base,
      ...raw,
      repos: { ...base.repos, ...(raw.repos ?? {}) },
    };
  } catch {
    return base;
  }
}

/** Resolve a task's repo alias to its checkout root (or undefined). */
export function repoRoot(config: TaskqConfig, repo: string | null): string | undefined {
  if (!repo) return undefined;
  const r = config.repos[repo];
  return r ? resolve(r) : undefined;
}

/** Validate + narrow a config patch (returns the cleaned patch, or throws). */
export function validateConfigPatch(patch: TaskqConfigPatch): TaskqConfigPatch {
  const out: TaskqConfigPatch = {};
  if (patch.jobs !== undefined) {
    if (!Number.isInteger(patch.jobs) || patch.jobs < 1 || patch.jobs > 16) throw new Error('jobs must be 1–16');
    out.jobs = patch.jobs;
  }
  if (patch.model !== undefined) {
    if (!CONFIG_MODEL_ALIASES.includes(patch.model))
      throw new Error(`model must be one of ${CONFIG_MODEL_ALIASES.join(', ')}`);
    out.model = patch.model;
  }
  if (patch.think !== undefined) {
    if (patch.think !== '' && !CONFIG_THINK_LEVELS.includes(patch.think)) throw new Error('invalid thinking level');
    out.think = patch.think || undefined;
  }
  if (patch.fast !== undefined) {
    if (typeof patch.fast !== 'boolean') throw new Error('fast must be boolean');
    out.fast = patch.fast;
  }
  if (patch.leaseTtlMs !== undefined) {
    if (!Number.isInteger(patch.leaseTtlMs) || patch.leaseTtlMs < 60_000) throw new Error('leaseTtlMs must be ≥ 60000');
    out.leaseTtlMs = patch.leaseTtlMs;
  }
  if (patch.triageEnabled !== undefined) {
    if (typeof patch.triageEnabled !== 'boolean') throw new Error('triageEnabled must be boolean');
    out.triageEnabled = patch.triageEnabled;
  }
  for (const k of ['usagePollMinutes', 'usageCostPollMinutes'] as const) {
    if (patch[k] !== undefined) {
      const v = patch[k] as number;
      if (!Number.isInteger(v) || v < 0 || v > MAX_POLL_MINUTES)
        throw new Error(`${k} must be 0–${MAX_POLL_MINUTES} (0 = off)`);
      out[k] = v;
    }
  }
  if (patch.fleet !== undefined) {
    if (
      patch.fleet !== null &&
      !(
        Array.isArray(patch.fleet) &&
        patch.fleet.every(
          (t) =>
            t &&
            Array.isArray(t.models) &&
            t.models.every((m) => CONFIG_MODEL_ALIASES.includes(m)) &&
            Number.isInteger(t.jobs) &&
            t.jobs >= 1 &&
            t.jobs <= 16,
        )
      )
    ) {
      throw new Error('fleet must be tiers of { models:[alias…], jobs:1–16 } (or null to clear)');
    }
    out.fleet = patch.fleet ?? undefined;
  }
  return out;
}

/**
 * Merge a validated patch into `~/.taskq/config.json` and return the new config.
 * Writes only the user-editable fields alongside whatever else is in the file
 * (repos stay as-is). `fleet: []`/undefined clears fleet mode.
 */
export function saveTaskqConfig(patch: TaskqConfigPatch): TaskqConfig {
  const clean = validateConfigPatch(patch);
  const path = join(taskqHome(), 'config.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // no file yet — start from {}
  }
  if (clean.jobs !== undefined) raw.jobs = clean.jobs;
  if (clean.model !== undefined) raw.model = clean.model;
  if ('think' in clean) raw.think = clean.think;
  if (clean.fast !== undefined) raw.fast = clean.fast;
  if (clean.leaseTtlMs !== undefined) raw.leaseTtlMs = clean.leaseTtlMs;
  if (clean.usagePollMinutes !== undefined) raw.usagePollMinutes = clean.usagePollMinutes;
  if (clean.usageCostPollMinutes !== undefined) raw.usageCostPollMinutes = clean.usageCostPollMinutes;
  if (clean.triageEnabled !== undefined) raw.triage = { enabled: clean.triageEnabled };
  if ('fleet' in clean) {
    if (clean.fleet?.length) raw.fleet = clean.fleet;
    else delete raw.fleet;
  }
  mkdirSync(taskqHome(), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  return loadTaskqConfig();
}
