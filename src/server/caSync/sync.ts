import { addTask, type NewTask } from 'cwip/taskq';
import { getErrorMessage, logger } from 'cwip';
import type { PulledTask } from '../../shared/caSync';
import { createDraft, kickForgeWorker } from '../forge';
import { getTaskqDb } from '../taskqDb';
import { type CaClient, makeCaClient } from './client';
import { type CaSyncSettings, resolveCaSync } from './config';
import { buildCapacity, buildTasks, buildTimings, buildUsage } from './snapshots';

// The cursedalchemy → rubato sync: pull published tasks from ca into the taskq
// queue (directly, or via Forge/Ollama enhancement), and push orchestration data
// (usage/capacity/queue/timing) back to ca for the owner's dashboard.

const toNewTask = (t: PulledTask): NewTask => ({
  title: t.title,
  body: t.body || undefined,
  repo: t.repo ?? undefined,
  model: t.model ?? undefined,
  think: t.think ?? undefined,
  fast: t.fast,
  group_key: t.groupKey ?? undefined,
  slug: t.slug ?? undefined,
  needs: t.needs.length ? t.needs : undefined,
  // ca's `hold` maps to taskq's `on_hold` (queued but paused).
  status: t.status === 'hold' ? 'on_hold' : 'ready',
});

export interface SyncDeps {
  settings?: CaSyncSettings;
  client?: CaClient;
  /** Add a task straight to the queue; returns its taskq id. */
  enqueueDirect?: (t: PulledTask) => number;
  /** Hand a rough draft to Forge for Ollama enhancement + auto-publish. */
  enqueueOllama?: (t: PulledTask) => void;
}

const defaultEnqueueDirect = (t: PulledTask): number =>
  addTask(getTaskqDb(), toNewTask(t), { at: 'bottom' });

const defaultEnqueueOllama = (t: PulledTask): void => {
  createDraft({
    title: t.title,
    raw_content: t.body,
    target_status: t.status === 'hold' ? 'hold' : 'ready',
  });
  kickForgeWorker();
};

/**
 * Pull ca's published tasks once and enqueue each (routing by enhance mode), then
 * report back to ca what happened. ca locks each task as part of the pull, so a
 * task is only ever pulled here once. Per-task failures are isolated + reported.
 */
export async function pullOnce(deps: SyncDeps = {}): Promise<{ pulled: number; queued: number }> {
  const settings = deps.settings ?? (await resolveCaSync());
  if (!settings.enabled) return { pulled: 0, queued: 0 };
  const client = deps.client ?? makeCaClient(settings);
  const enqueueDirect = deps.enqueueDirect ?? defaultEnqueueDirect;
  const enqueueOllama = deps.enqueueOllama ?? defaultEnqueueOllama;

  const tasks = await client.pull();
  let queued = 0;
  for (const t of tasks) {
    try {
      if (t.enhanceMode === 'ollama') {
        enqueueOllama(t);
        await client.update(t.id, {
          status: 'enhancing',
          summary: 'Queued for Ollama (Forge) enhancement on rubato.',
          model: t.model,
          think: t.think,
        });
      } else {
        const remoteTaskId = enqueueDirect(t);
        await client.update(t.id, {
          remoteTaskId,
          status: t.status === 'hold' ? 'on_hold' : 'ready',
          summary: 'Added to the rubato taskq queue.',
          model: t.model,
          think: t.think,
        });
      }
      queued++;
    } catch (err) {
      logger.error(`[ca-sync] failed to enqueue ca task ${t.id}:`, getErrorMessage(err));
      // Best-effort: tell ca it failed so the owner sees it (don't rethrow).
      try {
        await client.update(t.id, { status: 'failed', summary: `rubato: ${getErrorMessage(err)}` });
      } catch {
        // ca unreachable — the next push cycle will retry status reporting.
      }
    }
  }
  return { pulled: tasks.length, queued };
}

/** Push the current orchestration snapshots to ca. Each kind is isolated. */
export async function pushOnce(deps: SyncDeps = {}): Promise<void> {
  const settings = deps.settings ?? (await resolveCaSync());
  if (!settings.enabled) return;
  const client = deps.client ?? makeCaClient(settings);

  const send = async (kind: Parameters<CaClient['pushData']>[0], build: () => unknown) => {
    try {
      const payload = await build();
      if (payload) await client.pushData(kind, payload);
    } catch (err) {
      logger.debug?.(`[ca-sync] push ${kind} failed:`, getErrorMessage(err));
    }
  };

  try {
    await client.ping();
  } catch (err) {
    logger.debug?.('[ca-sync] ping failed:', getErrorMessage(err));
  }
  await send('usage', buildUsage);
  await send('capacity', buildCapacity);
  await send('tasks', buildTasks);
  await send('timings', buildTimings);
}

// ── Background worker ────────────────────────────────────────────────────────
let pullTimer: ReturnType<typeof setInterval> | null = null;
let pushTimer: ReturnType<typeof setInterval> | null = null;
let pulling = false;
let pushing = false;

const safePull = async () => {
  if (pulling) return;
  pulling = true;
  try {
    await pullOnce();
  } catch (err) {
    logger.debug?.('[ca-sync] pull cycle failed:', getErrorMessage(err));
  } finally {
    pulling = false;
  }
};

const safePush = async () => {
  if (pushing) return;
  pushing = true;
  try {
    await pushOnce();
  } catch (err) {
    logger.debug?.('[ca-sync] push cycle failed:', getErrorMessage(err));
  } finally {
    pushing = false;
  }
};

/**
 * Start the background sync (pull + push loops). No-op when sync isn't configured
 * (no CA_SYNC_URL / CA_SYNC_API_KEY) so a vanilla rubato install does nothing.
 */
export async function startCaSync(): Promise<void> {
  if (pullTimer || pushTimer) return; // already running
  const settings = await resolveCaSync();
  if (!settings.enabled) {
    logger.info('[ca-sync] disabled (set CA_SYNC_URL + CA_SYNC_API_KEY to enable).');
    return;
  }
  logger.info(`[ca-sync] enabled → ${settings.url} as host "${settings.hostId}".`);
  // Kick off shortly after boot, then on the configured cadence.
  setTimeout(() => void safePull(), 2_000);
  setTimeout(() => void safePush(), 4_000);
  pullTimer = setInterval(() => void safePull(), settings.pullIntervalMs);
  pushTimer = setInterval(() => void safePush(), settings.pushIntervalMs);
}

/** Stop the background sync (tests / shutdown). */
export function stopCaSync(): void {
  if (pullTimer) clearInterval(pullTimer);
  if (pushTimer) clearInterval(pushTimer);
  pullTimer = null;
  pushTimer = null;
}
