/**
 * Orchestration API: the unattended task-queue workflow dashboard + watchdog control.
 *
 *   GET  /api/orchestration                       → OrchestrationOverview (board + history + runs + stats)
 *   GET  /api/orchestration/files                 → OrchestrationFileInfo[] (editable allowlist, no content)
 *   GET  /api/orchestration/files/:key            → OrchestrationFileDoc (view)
 *   POST /api/orchestration/files/:key            → write { content } → OrchestrationFileDoc
 *
 *   GET  /api/orchestration/watchdog              → WatchdogSnapshot (config + status + instances + activeRun + pending + …)
 *   POST /api/orchestration/watchdog/config       → patch drain.config { enabled?, autoRestart?, jobs?, model?, thinkingLevel?, fastMode?, resumeAt?, … } → ConfigPatchResult
 *   POST /api/orchestration/watchdog/interval     → set launchd tick interval { seconds }
 *   POST /api/orchestration/watchdog/agent        → start/stop/restart the launchd watchdog AGENT { action } → WatchdogAgentResult
 *   POST /api/orchestration/watchdog/start        → start the drainer now { jobs? }
 *   POST /api/orchestration/watchdog/wake         → ensure the drainer runs at the configured JOBS (relaunch if short-handed)
 *   POST /api/orchestration/watchdog/restart      → restart the drainer { mode: 'graceful' | 'force' } → RestartResult
 *   POST /api/orchestration/watchdog/stop         → stop the drainer + its workers
 *   POST /api/orchestration/watchdog/instance/stop→ stop one worker { pid }
 *   POST /api/orchestration/watchdog/dev-server   → toggle orch dev server (:5175) { enabled } → { devServerEnabled }
 *   POST /api/orchestration/watchdog/heal         → re-open stalled [~] tasks → HealStalledResult
 *   GET  /api/orchestration/logs/:key?lines=N     → LogTail (tail a watchdog/run log)
 *   GET  /api/orchestration/false-done            → FalseDoneAlertsResult (deduped auto-reverted tasks)
 *
 * Read parsing is done by the pure library (`src/lib/orchestration/`); the file
 * read/write lives in `src/server/orchestration.ts` behind a fixed allowlist, and
 * the watchdog observe/control side-effects live in `src/server/watchdog.ts`
 * (every action is pinned to a resolved orchestration path / known pid).
 */

import { TaskConflictError } from '../lib/orchestration';
import type {
  DrainConfigPatch,
  FleetTier,
  SaveFleetPreset,
  TaskDraft,
  TaskInsertPosition,
  ThinkingLevel,
} from '../shared/orchestration';
import { DRAIN_MODEL_IDS, THINKING_LEVELS } from '../shared/orchestration';
import { getClaudeRateLimits } from './claudeUsage';
import type { TimingQuery } from './db';
import { json, jsonError, readJsonBody } from './http';
import {
  createTask,
  deleteTask,
  getOverview,
  healStalledTasks,
  listFiles,
  readFileDoc,
  updateTask,
  writeFileDoc,
} from './orchestration';
import { clearStoredTimings, getEntryCategoryStats, getTimingOverview, ingestTimings } from './orchestrationTimings';
import {
  applyDrainConfigPatch,
  applyFleetPreset,
  controlWatchdog,
  deleteFleetPreset,
  getFalseDoneAlerts,
  getWatchdog,
  listFleetPresets,
  reconcileFleet,
  restartDrainer,
  saveFleetPreset,
  setDevServerEnabled,
  setWatchdogInterval,
  startDrainer,
  stopDrainer,
  stopInstance,
  tailLog,
  wakeWorkers,
} from './watchdog';

export async function handleOrchestrationApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/orchestration') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    try {
      return json(await getOverview());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to read orchestration data', 500);
    }
  }

  // ── Task builder: compose/edit/delete a TASKS.md entry ──────────────────────
  if (pathname === '/api/orchestration/tasks') {
    return handleTasks(req);
  }

  // ── Watchdog control + observe ──────────────────────────────────────────────
  if (pathname.startsWith('/api/orchestration/watchdog')) {
    return handleWatchdog(pathname, req);
  }

  // ── Named fleet presets (save / load / swap worker-mix configs) ─────────────
  if (pathname.startsWith('/api/orchestration/fleet-presets')) {
    return handleFleetPresets(pathname, req);
  }

  // POST /api/orchestration/fleet/reconcile → grow the fleet to cover unservable tasks.
  if (pathname === '/api/orchestration/fleet/reconcile') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    try {
      return json(await reconcileFleet());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to reconcile fleet', 500);
    }
  }

  // GET /api/orchestration/claude-usage → live rate-limit probe + key status.
  if (pathname === '/api/orchestration/claude-usage') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    try {
      return json(await getClaudeRateLimits());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to fetch claude usage', 500);
    }
  }

  // ── Orchestration Processing (per-category timing analytics) ────────────────
  if (pathname === '/api/orchestration/timings' || pathname.startsWith('/api/orchestration/timings/')) {
    return handleTimings(pathname, req);
  }

  // GET /api/orchestration/logs/:key?lines=N → tail an allowlisted log file.
  if (pathname.startsWith('/api/orchestration/logs/')) {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    const key = decodeURIComponent(pathname.slice('/api/orchestration/logs/'.length));
    if (!key) return jsonError('log key required', 400);
    const lines = Number.parseInt(new URL(req.url).searchParams.get('lines') ?? '', 10);
    const tail = await tailLog(key, Number.isFinite(lines) ? lines : undefined);
    return tail ? json(tail) : jsonError(`unknown log: ${key}`, 404);
  }

  // GET /api/orchestration/false-done → deduped auto-reverted false-done alerts.
  if (pathname === '/api/orchestration/false-done') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    try {
      return json(await getFalseDoneAlerts());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to read false-done alerts', 500);
    }
  }

  if (pathname === '/api/orchestration/files') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return json(await listFiles());
  }

  // GET /api/orchestration/files/:key → view; POST writes it. The key maps to a
  // fixed server-derived (allowlisted, realpath-canonicalized) path.
  if (pathname.startsWith('/api/orchestration/files/')) {
    const key = decodeURIComponent(pathname.slice('/api/orchestration/files/'.length));
    if (!key) return jsonError('file key required', 400);
    if (req.method === 'GET') {
      const doc = await readFileDoc(key);
      return doc ? json(doc) : jsonError(`unknown orchestration file: ${key}`, 404);
    }
    if (req.method === 'POST') {
      const body = await readJsonBody<{ content?: string }>(req);
      if (!body || typeof body.content !== 'string') return jsonError('content (string) required', 400);
      try {
        const doc = await writeFileDoc(key, body.content);
        return doc ? json(doc) : jsonError(`unknown orchestration file: ${key}`, 404);
      } catch (e) {
        return jsonError(e instanceof Error ? e.message : 'write failed', 400);
      }
    }
    return jsonError('use GET or POST', 405);
  }

  return jsonError(`not found: ${pathname}`, 404);
}

/**
 * Task builder sub-router (compose/edit/delete a TASKS.md entry):
 *   POST   /api/orchestration/tasks  → create  { draft, position } → { board }
 *   PATCH  /api/orchestration/tasks  → update  { anchorHeading, draft } → { board }
 *   DELETE /api/orchestration/tasks  → delete  { anchorHeading } → { board }
 *
 * The draft is validated server-side (the authoritative gate — `validateTaskDraft`);
 * the write goes through an in-process queue + cross-process lock + atomic rename
 * (see `src/server/orchestration.ts`) so a concurrent worker claim is never
 * clobbered. A vanished `anchorHeading` (the task was claimed/removed since the
 * page loaded) returns 409 so the UI refreshes instead of overwriting live state.
 */
async function handleTasks(req: Request): Promise<Response> {
  const fail = (e: unknown) =>
    jsonError(e instanceof Error ? e.message : 'task write failed', e instanceof TaskConflictError ? 409 : 400);

  if (req.method === 'POST') {
    const body = await readJsonBody<{ draft?: TaskDraft; position?: TaskInsertPosition }>(req);
    if (!body?.draft || typeof body.draft !== 'object') return jsonError('a task { draft } is required', 400);
    const position: TaskInsertPosition = body.position ?? { at: 'top' };
    try {
      return json({ board: await createTask(body.draft, position) });
    } catch (e) {
      return fail(e);
    }
  }

  if (req.method === 'PATCH' || req.method === 'PUT') {
    const body = await readJsonBody<{ anchorHeading?: string; draft?: TaskDraft }>(req);
    if (typeof body?.anchorHeading !== 'string' || !body.anchorHeading) {
      return jsonError('anchorHeading (string) is required', 400);
    }
    if (!body.draft || typeof body.draft !== 'object') return jsonError('a task { draft } is required', 400);
    try {
      return json({ board: await updateTask(body.anchorHeading, body.draft) });
    } catch (e) {
      return fail(e);
    }
  }

  if (req.method === 'DELETE') {
    const body = await readJsonBody<{ anchorHeading?: string }>(req);
    if (typeof body?.anchorHeading !== 'string' || !body.anchorHeading) {
      return jsonError('anchorHeading (string) is required', 400);
    }
    try {
      return json({ board: await deleteTask(body.anchorHeading) });
    } catch (e) {
      return fail(e);
    }
  }

  return jsonError('use POST, PATCH, or DELETE', 405);
}

/**
 * Sub-router for the Orchestration Processing timing analytics:
 *   GET  /api/orchestration/timings?from=&to=&repo=   → TimingOverview (aggregated)
 *   GET  /api/orchestration/timings/entry?start=&end=&repo= → CategoryStat[] for one history entry
 *   POST /api/orchestration/timings/ingest            → sync from timing-*.jsonl
 *   POST /api/orchestration/timings/clear  { before? } → delete all / older rows
 * Only the filters (epoch-ms bounds + a repo string) come from the client — never a
 * path; the ingest source dir is fixed server-side (see orchestrationTimings.ts).
 */
async function handleTimings(pathname: string, req: Request): Promise<Response> {
  // GET /api/orchestration/timings/entry?start=<ISO>&end=<ISO>&repo=<> →
  // CategoryStat[] for one history entry's time window.
  if (pathname === '/api/orchestration/timings/entry') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    const params = new URL(req.url).searchParams;
    const start = params.get('start') ?? '';
    const end = params.get('end') ?? '';
    if (!start || !end) return jsonError('start and end query params are required', 400);
    const repoRaw = params.get('repo');
    const repo = repoRaw && repoRaw !== 'all' ? repoRaw : undefined;
    try {
      return json(getEntryCategoryStats(start, end, repo));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to get entry stats', 500);
    }
  }

  if (pathname === '/api/orchestration/timings') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    const params = new URL(req.url).searchParams;
    const num = (v: string | null): number | undefined => {
      if (v == null || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const repoRaw = params.get('repo');
    const q: TimingQuery = {
      from: num(params.get('from')),
      to: num(params.get('to')),
      repo: repoRaw && repoRaw !== 'all' ? repoRaw : undefined,
    };
    try {
      return json(await getTimingOverview(q));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to read timing data', 500);
    }
  }

  // All mutations are POST.
  if (pathname === '/api/orchestration/timings/ingest') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    try {
      return json(await ingestTimings());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'ingest failed', 500);
    }
  }

  if (pathname === '/api/orchestration/timings/clear') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const body = await readJsonBody<{ before?: number }>(req);
    const before = Number(body?.before);
    try {
      return json(clearStoredTimings(Number.isFinite(before) && before > 0 ? before : undefined));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'clear failed', 500);
    }
  }

  return jsonError(`not found: ${pathname}`, 404);
}

/** Sub-router for the `/api/orchestration/watchdog…` control + observe endpoints. */
async function handleWatchdog(pathname: string, req: Request): Promise<Response> {
  // GET …/watchdog → the live snapshot.
  if (pathname === '/api/orchestration/watchdog') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    try {
      return json(await getWatchdog());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to read watchdog state', 500);
    }
  }

  // All control actions are POST.
  if (req.method !== 'POST') return jsonError('use POST', 405);

  if (pathname === '/api/orchestration/watchdog/config') {
    const body = await readJsonBody<DrainConfigPatch>(req);
    if (!body || typeof body !== 'object') return jsonError('a config patch object is required', 400);
    const patch = sanitizePatch(body);
    if (patch === null) {
      return jsonError('invalid config patch (check enabled/autoRestart/jobs/model/thinkingLevel/fastMode)', 400);
    }
    try {
      // Returns { config, changed, autoRestart? } — auto-restart fires when
      // AUTO_RESTART is on, a needs-restart key changed, and a drainer is live.
      return json(await applyDrainConfigPatch(patch));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to write drain.config', 500);
    }
  }

  if (pathname === '/api/orchestration/watchdog/restart') {
    const body = await readJsonBody<{ mode?: string }>(req);
    // Default to graceful (let the in-flight task finish); only 'force' kills now.
    const mode = body?.mode === 'force' ? 'force' : 'graceful';
    try {
      return json(await restartDrainer(mode));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to restart drainer', 500);
    }
  }

  if (pathname === '/api/orchestration/watchdog/interval') {
    const body = await readJsonBody<{ seconds?: number }>(req);
    const seconds = Number(body?.seconds);
    if (!Number.isFinite(seconds) || seconds < 1) return jsonError('seconds (>= 1) is required', 400);
    try {
      return json(await setWatchdogInterval(seconds));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to set interval', 500);
    }
  }

  if (pathname === '/api/orchestration/watchdog/agent') {
    const body = await readJsonBody<{ action?: string }>(req);
    const action = body?.action;
    if (action !== 'start' && action !== 'stop' && action !== 'restart') {
      return jsonError("action must be 'start', 'stop', or 'restart'", 400);
    }
    try {
      return json(await controlWatchdog(action));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to control watchdog agent', 500);
    }
  }

  if (pathname === '/api/orchestration/watchdog/start') {
    const body = await readJsonBody<{ jobs?: number }>(req);
    const jobs = Number(body?.jobs);
    try {
      return json(await startDrainer(Number.isFinite(jobs) && jobs > 0 ? { jobs } : {}));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to start drainer', 500);
    }
  }

  if (pathname === '/api/orchestration/watchdog/wake') {
    try {
      return json(await wakeWorkers());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to wake workers', 500);
    }
  }

  if (pathname === '/api/orchestration/watchdog/stop') {
    try {
      return json(await stopDrainer());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to stop drainer', 500);
    }
  }

  if (pathname === '/api/orchestration/watchdog/instance/stop') {
    const body = await readJsonBody<{ pid?: number }>(req);
    const pid = Number(body?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return jsonError('a positive integer pid is required', 400);
    try {
      return json(await stopInstance(pid));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to stop instance', 500);
    }
  }

  // POST /api/orchestration/watchdog/dev-server → toggle localhost orch dev server (:5175)
  if (pathname === '/api/orchestration/watchdog/dev-server') {
    const body = await readJsonBody<{ enabled?: boolean }>(req);
    if (typeof body?.enabled !== 'boolean') return jsonError('enabled (boolean) is required', 400);
    try {
      const enabled = await setDevServerEnabled(body.enabled);
      return json({ devServerEnabled: enabled });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to set dev server state', 500);
    }
  }

  // POST /api/orchestration/watchdog/heal → re-open stalled [~] tasks in TASKS.md.
  // Safe to call at any time; only heals tasks older than STALE_INSTANCE_SECONDS (1h).
  if (pathname === '/api/orchestration/watchdog/heal') {
    try {
      return json(await healStalledTasks());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'heal failed', 500);
    }
  }

  return jsonError(`not found: ${pathname}`, 404);
}

/** A raw fleet-tier from a request body is well-shaped (authoritative clamping is server-side). */
function isTierShape(t: unknown): t is FleetTier {
  return (
    t != null &&
    typeof t === 'object' &&
    typeof (t as FleetTier).modelAlias === 'string' &&
    typeof (t as FleetTier).slots === 'number' &&
    typeof (t as FleetTier).thinkingLevel === 'string' &&
    typeof (t as FleetTier).fastMode === 'boolean'
  );
}

/**
 * Named fleet presets — save a worker-mix under a name, list them, delete one, and
 * apply (swap) one into `drain.config` in a single click.
 *
 *   GET    /api/orchestration/fleet-presets         → FleetPreset[]
 *   POST   /api/orchestration/fleet-presets         → save { name, tiers, note? } → FleetPreset[]
 *   DELETE /api/orchestration/fleet-presets/:id      → FleetPreset[]
 *   POST   /api/orchestration/fleet-presets/:id/apply→ ApplyFleetPresetResult
 */
async function handleFleetPresets(pathname: string, req: Request): Promise<Response> {
  const rest = pathname.slice('/api/orchestration/fleet-presets'.length).replace(/^\/+|\/+$/g, '');

  // Collection: GET (list) / POST (save).
  if (rest === '') {
    if (req.method === 'GET') {
      try {
        return json(await listFleetPresets());
      } catch (e) {
        return jsonError(e instanceof Error ? e.message : 'failed to read fleet presets', 500);
      }
    }
    if (req.method === 'POST') {
      const body = await readJsonBody<SaveFleetPreset>(req);
      if (!body || typeof body !== 'object' || typeof body.name !== 'string' || !body.name.trim()) {
        return jsonError('a preset { name, tiers } is required', 400);
      }
      if (!Array.isArray(body.tiers) || body.tiers.length === 0 || !body.tiers.every(isTierShape)) {
        return jsonError('tiers must be a non-empty array of { modelAlias, slots, thinkingLevel, fastMode }', 400);
      }
      try {
        return json(await saveFleetPreset({ name: body.name, tiers: body.tiers, note: body.note }));
      } catch (e) {
        return jsonError(e instanceof Error ? e.message : 'failed to save fleet preset', 500);
      }
    }
    return jsonError('use GET or POST', 405);
  }

  // Item: DELETE …/:id, or POST …/:id/apply.
  const applyMatch = rest.match(/^([^/]+)\/apply$/);
  if (applyMatch) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const id = decodeURIComponent(applyMatch[1]);
    try {
      return json(await applyFleetPreset(id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to apply fleet preset';
      return jsonError(msg, msg.startsWith('unknown fleet preset') ? 404 : 500);
    }
  }
  if (!rest.includes('/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    const id = decodeURIComponent(rest);
    try {
      return json(await deleteFleetPreset(id));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to delete fleet preset', 500);
    }
  }

  return jsonError(`not found: ${pathname}`, 404);
}

/** Validate + narrow a raw config-patch body to the allowed fields (null = invalid). */
export function sanitizePatch(body: DrainConfigPatch): DrainConfigPatch | null {
  const patch: DrainConfigPatch = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return null;
    patch.enabled = body.enabled;
  }
  if (body.autoRestart !== undefined) {
    if (typeof body.autoRestart !== 'boolean') return null;
    patch.autoRestart = body.autoRestart;
  }
  if (body.jobs !== undefined) {
    if (typeof body.jobs !== 'number' || !Number.isFinite(body.jobs) || body.jobs < 1) return null;
    patch.jobs = body.jobs;
  }
  if (body.model !== undefined) {
    // Validate against the allowed worker model ids (the dropdown's set).
    if (typeof body.model !== 'string' || !DRAIN_MODEL_IDS.includes(body.model)) return null;
    patch.model = body.model;
  }
  if (body.thinkingLevel !== undefined) {
    if (!(THINKING_LEVELS as string[]).includes(body.thinkingLevel)) return null;
    patch.thinkingLevel = body.thinkingLevel as ThinkingLevel;
  }
  if (body.fastMode !== undefined) {
    if (typeof body.fastMode !== 'boolean') return null;
    patch.fastMode = body.fastMode;
  }
  if (body.autoTier !== undefined) {
    if (typeof body.autoTier !== 'boolean') return null;
    patch.autoTier = body.autoTier;
  }
  if (body.startDir !== undefined) {
    if (typeof body.startDir !== 'string') return null;
    patch.startDir = body.startDir;
  }
  if (body.addDir !== undefined) {
    if (typeof body.addDir !== 'string') return null;
    patch.addDir = body.addDir;
  }
  if (body.resumeAt !== undefined) {
    // A UNIX epoch in SECONDS; `0` (or any non-positive) is the explicit "clear" signal.
    if (typeof body.resumeAt !== 'number' || !Number.isFinite(body.resumeAt)) return null;
    patch.resumeAt = body.resumeAt;
  }
  if (body.fleetTiers !== undefined) {
    // `null` (or `[]`) clears fleet mode → flat. Otherwise accept a well-shaped
    // array of tiers; the authoritative alias/slot/thinking clamping lives in
    // `applyDrainPatch`, so here we only gate the structure.
    if (body.fleetTiers === null) {
      patch.fleetTiers = null;
    } else if (
      Array.isArray(body.fleetTiers) &&
      body.fleetTiers.every(
        (t) =>
          t != null &&
          typeof t === 'object' &&
          typeof t.modelAlias === 'string' &&
          typeof t.slots === 'number' &&
          typeof t.thinkingLevel === 'string' &&
          typeof t.fastMode === 'boolean',
      )
    ) {
      patch.fleetTiers = body.fleetTiers;
    } else {
      return null;
    }
  }
  if (Object.keys(patch).length === 0) return null;
  return patch;
}
