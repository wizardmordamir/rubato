/**
 * Orchestrator config — `~/.taskq/config.json` (JOBS, default model, fleet tiers,
 * repo roots). All optional; sane defaults derived from the home dir. The drain
 * entrypoint reads this to size the worker pool + tier the fleet.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BackoffOpts, DEFAULT_BACKOFF, DEFAULT_MAX_ATTEMPTS, taskqHome } from 'cwip/taskq';

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
  /**
   * Hard ceiling (ms) on a single worker's `claude -p` agent run. A hung agent
   * keeps heartbeating, so the lease never expires and the reaper can't free it —
   * which pins the worker AND prevents the drain from ever exiting (launchd can't
   * relaunch while it's alive). This timeout kills such a run so the task fails,
   * the worker moves on, and the queue keeps flowing. Default 2h (well above any
   * legitimate task; only catches genuine hangs).
   */
  taskTimeoutMs: number;
  /**
   * Bounded auto-retry ceiling: how many times a failed/reaped task is re-queued
   * (with backoff) before it parks terminal `failed`. A per-task `max_attempts`
   * overrides this. Default 3.
   */
  maxAttempts: number;
  /**
   * Exponential-backoff schedule for the re-queue delay (base/factor/cap/jitter).
   * Spreads a fleet's retries and gives a transient outage time to clear before
   * the automatic retry. Default 1m → 5m → 20m (capped), ±20% jitter.
   */
  retryBackoff: BackoffOpts;
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
    | 'jobs'
    | 'model'
    | 'think'
    | 'fast'
    | 'fleet'
    | 'leaseTtlMs'
    | 'taskTimeoutMs'
    | 'maxAttempts'
    | 'retryBackoff'
    | 'usagePollMinutes'
    | 'usageCostPollMinutes'
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
    taskTimeoutMs: 2 * 60 * 60_000,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    retryBackoff: { ...DEFAULT_BACKOFF },
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
      // Merge sub-fields so a partial backoff override keeps the rest of the defaults.
      retryBackoff: { ...base.retryBackoff, ...(raw.retryBackoff ?? {}) },
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
  if (patch.taskTimeoutMs !== undefined) {
    // ≥ 1 min (a real task takes minutes); ≤ 24h (a safety ceiling, not a budget).
    if (!Number.isInteger(patch.taskTimeoutMs) || patch.taskTimeoutMs < 60_000 || patch.taskTimeoutMs > 86_400_000)
      throw new Error('taskTimeoutMs must be 60000–86400000');
    out.taskTimeoutMs = patch.taskTimeoutMs;
  }
  if (patch.maxAttempts !== undefined) {
    if (!Number.isInteger(patch.maxAttempts) || patch.maxAttempts < 1 || patch.maxAttempts > 10)
      throw new Error('maxAttempts must be 1–10');
    out.maxAttempts = patch.maxAttempts;
  }
  if (patch.retryBackoff !== undefined) {
    const b = patch.retryBackoff;
    const numOk = (v: unknown, min: number) =>
      v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= min);
    if (
      !b ||
      typeof b !== 'object' ||
      !numOk(b.baseMs, 0) ||
      !numOk(b.capMs, 0) ||
      !numOk(b.factor, 1) ||
      !(b.jitter === undefined || (typeof b.jitter === 'number' && b.jitter >= 0 && b.jitter <= 1))
    ) {
      throw new Error('retryBackoff must be { baseMs≥0, capMs≥0, factor≥1, jitter 0–1 } (any subset)');
    }
    if (b.baseMs !== undefined && b.capMs !== undefined && b.capMs < b.baseMs)
      throw new Error('retryBackoff.capMs must be ≥ baseMs');
    // Keep only the recognised numeric knobs.
    out.retryBackoff = {
      ...(b.baseMs !== undefined ? { baseMs: b.baseMs } : {}),
      ...(b.capMs !== undefined ? { capMs: b.capMs } : {}),
      ...(b.factor !== undefined ? { factor: b.factor } : {}),
      ...(b.jitter !== undefined ? { jitter: b.jitter } : {}),
    };
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
  if (clean.taskTimeoutMs !== undefined) raw.taskTimeoutMs = clean.taskTimeoutMs;
  if (clean.maxAttempts !== undefined) raw.maxAttempts = clean.maxAttempts;
  if (clean.retryBackoff !== undefined) raw.retryBackoff = { ...(raw.retryBackoff as object), ...clean.retryBackoff };
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
