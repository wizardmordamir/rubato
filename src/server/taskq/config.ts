/**
 * Orchestrator config — `~/.taskq/config.json` (JOBS, default model, fleet tiers,
 * repo roots). All optional; sane defaults derived from the home dir. The drain
 * entrypoint reads this to size the worker pool + tier the fleet.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { taskqHome } from 'cwip/taskq';

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
  /** Optional fleet: distinct per-model worker pools (overrides `jobs`). */
  fleet?: FleetTier[];
  /** Lease TTL ms (worker must heartbeat within this). */
  leaseTtlMs: number;
  /** repo alias → absolute checkout root. */
  repos: Record<string, string>;
  /** Opt-in auto-triage / epic decomposition (off by default — conservative). */
  triage?: { enabled: boolean };
}

function defaults(): TaskqConfig {
  const gh = join(homedir(), 'code', 'github');
  return {
    jobs: 2,
    model: 'opus',
    leaseTtlMs: 15 * 60_000,
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
