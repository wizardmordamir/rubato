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
 *   GET  /api/orchestration/logs/:key?lines=N     → LogTail (tail a watchdog/run log)
 *
 * Read parsing is done by the pure library (`src/lib/orchestration/`); the file
 * read/write lives in `src/server/orchestration.ts` behind a fixed allowlist, and
 * the watchdog observe/control side-effects live in `src/server/watchdog.ts`
 * (every action is pinned to a resolved orchestration path / known pid).
 */

import type { DrainConfigPatch, ThinkingLevel } from '../shared/orchestration';
import { DRAIN_MODEL_IDS, THINKING_LEVELS } from '../shared/orchestration';
import type { TimingQuery } from './db';
import { json, jsonError, readJsonBody } from './http';
import { getOverview, listFiles, readFileDoc, writeFileDoc } from './orchestration';
import { clearStoredTimings, getTimingOverview, ingestTimings } from './orchestrationTimings';
import {
  applyDrainConfigPatch,
  controlWatchdog,
  getWatchdog,
  restartDrainer,
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

  // ── Watchdog control + observe ──────────────────────────────────────────────
  if (pathname.startsWith('/api/orchestration/watchdog')) {
    return handleWatchdog(pathname, req);
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
 * Sub-router for the Orchestration Processing timing analytics:
 *   GET  /api/orchestration/timings?from=&to=&repo=  → TimingOverview (aggregated)
 *   POST /api/orchestration/timings/ingest           → sync from timing-*.jsonl
 *   POST /api/orchestration/timings/clear  { before? } → delete all / older rows
 * Only the filters (epoch-ms bounds + a repo string) come from the client — never a
 * path; the ingest source dir is fixed server-side (see orchestrationTimings.ts).
 */
async function handleTimings(pathname: string, req: Request): Promise<Response> {
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

  return jsonError(`not found: ${pathname}`, 404);
}

/** Validate + narrow a raw config-patch body to the allowed fields (null = invalid). */
function sanitizePatch(body: DrainConfigPatch): DrainConfigPatch | null {
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
  if (Object.keys(patch).length === 0) return null;
  return patch;
}
