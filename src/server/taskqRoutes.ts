/**
 * Taskq (v2 orchestrator) API — CRUD over the SQLite queue for the board/builder.
 * The engine (cwip/taskq) is the authority (validation, atomic writes); these
 * routes just open the handle, call it, and return the rebuilt board. Run-side
 * verbs (claim/complete) aren't here — the orchestrator/CLI own those.
 *
 *   GET    /api/taskq                      → TaskqBoard
 *   GET    /api/taskq/capacity             → CapacitySnapshot (schedule decision + ready-task eligibility)
 *   POST   /api/taskq/tasks                → add  { draft, position? } → { board, id }
 *   PATCH  /api/taskq/tasks/:id            → update { patch } → { board }
 *   DELETE /api/taskq/tasks/:id            → { board }
 *   POST   /api/taskq/tasks/:id/status     → { status, note? } → { board }
 *   POST   /api/taskq/tasks/:id/move       → { position } → { board }
 */

import {
  addTask,
  allBucketStates,
  calibrateBucket,
  deleteTask,
  getNeeds,
  listTasks,
  modelAliasFromId,
  moveTask,
  type NewTask,
  openClarifications,
  type Position,
  recordRun,
  releaseLease,
  setStatus,
  type TaskPatch,
  TASK_STATUSES,
  type TaskStatus,
  updateTask,
  USAGE_BUCKETS,
} from 'cwip/taskq';
import type { TaskqBoard } from '../shared/taskq';
import { loadTaskqConfig, saveTaskqConfig, type TaskqConfigPatch } from './taskq/config';
import { json, jsonError, readJsonBody } from './http';
import {
  currentInterval,
  drainerStatus,
  liveInstances,
  runDrainerNow,
  setDrainerStop,
  setWatchdog,
  setWatchdogInterval,
  tailWatchdogLog,
  taskqHistory,
} from './taskq/control';
import { resolveGateway } from './taskq/triage';
import { capacitySnapshot } from './taskq/capacity';
import { getTaskqDb } from './taskqDb';
import { getUiPref, setUiPref } from './db';
import { notesDir } from './orchestration';
import { parseRunsJsonl } from '../lib/orchestration';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SECTION_PREFS_KEY = 'taskq_section_collapse';

/**
 * Ingest completed bash-drain task results from the orchestration runs JSONL
 * files into the usage_ledger. Each claude -p result line has a session_id that
 * acts as a dedup key — repeated calls are safe (INSERT OR IGNORE).
 * Fire-and-forget: never throws, errors are silently ignored.
 */
async function ingestRunsFromJsonl(): Promise<void> {
  try {
    const dir = await notesDir();
    const runsDir = join(dir, 'orchestration', 'runs');
    let names: string[];
    try {
      names = (await readdir(runsDir)).filter((n) => n.startsWith('run-') && n.endsWith('.jsonl'));
    } catch {
      return; // runs dir doesn't exist yet
    }
    const db = getTaskqDb();
    for (const name of names) {
      const text = await readFile(join(runsDir, name), 'utf8').catch(() => '');
      if (!text) continue;
      for (const entry of parseRunsJsonl(name, text)) {
        if (!entry.sessionId || !entry.outputTokens) continue;
        const alias = modelAliasFromId(entry.model);
        const atMs = entry.at ? new Date(entry.at).getTime() : Date.now();
        recordRun(db, { at: atMs, model: alias, outputTokens: entry.outputTokens, sessionId: entry.sessionId });
      }
    }
  } catch {
    // ingest is best-effort — never block the response
  }
}

/**
 * Auto-assign numeric slug (String(id)) to any task that lacks one, so every
 * task is addressable as a dependency without manual `(id:X)` markers.
 * Skips tasks whose numeric ID is already taken as another task's slug (rare).
 * Safe to call on every board fetch — only touches slug=NULL rows.
 */
function backfillNumericSlugs(db: ReturnType<typeof getTaskqDb>): void {
  db.run(
    `UPDATE tasks SET slug = CAST(id AS TEXT)
     WHERE slug IS NULL
       AND NOT EXISTS (SELECT 1 FROM tasks t2 WHERE t2.slug = CAST(tasks.id AS TEXT))`,
  );
}

/** Rebuild the whole board (tasks + needs + per-status counts + runtime data). */
function board(): TaskqBoard {
  const db = getTaskqDb();
  backfillNumericSlugs(db);

  // Lease data for claimed tasks (claimed_at keyed by task_id).
  const leases = db.query(`SELECT task_id, claimed_at FROM leases`).all() as { task_id: number; claimed_at: number }[];
  const leaseByTaskId = new Map(leases.map((l) => [l.task_id, l.claimed_at]));

  // Most-recent completion row per done task.
  type CompRow = { task_id: number; started_at: number | null; ended_at: number; duration_s: number | null; summary: string | null; commit: string | null };
  const completions = db
    .query(`SELECT task_id, started_at, ended_at, duration_s, summary, "commit" FROM completions ORDER BY ended_at DESC`)
    .all() as CompRow[];
  const completionByTaskId = new Map<number, CompRow>();
  for (const c of completions) {
    if (!completionByTaskId.has(c.task_id)) completionByTaskId.set(c.task_id, c);
  }

  const tasks = listTasks(db).map((t) => {
    const base = { ...t, needs: getNeeds(db, t.id) };
    if (t.status === 'claimed') {
      return { ...base, claimed_at: leaseByTaskId.get(t.id) ?? null };
    }
    if (t.status === 'done') {
      const c = completionByTaskId.get(t.id);
      if (c) return { ...base, started_at: c.started_at, ended_at: c.ended_at, duration_s: c.duration_s, summary: c.summary, commit: c.commit };
    }
    return base;
  });

  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { tasks, counts, total: tasks.length };
}

export async function handleTaskqApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/taskq') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    try {
      return json(board());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to read taskq board', 500);
    }
  }

  if (pathname === '/api/taskq/tasks') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const body = await readJsonBody<{ draft?: NewTask; position?: Position }>(req);
    if (!body?.draft || typeof body.draft !== 'object') return jsonError('a task { draft } is required', 400);
    try {
      const db = getTaskqDb();
      const id = addTask(db, body.draft, body.position ?? { at: 'top' });
      // Auto-assign numeric slug if the user didn't provide one.
      if (!body.draft.slug) {
        db.run(
          `UPDATE tasks SET slug = CAST(id AS TEXT) WHERE id = ? AND NOT EXISTS (SELECT 1 FROM tasks t2 WHERE t2.slug = CAST(? AS TEXT) AND t2.id <> ?)`,
          id, id, id,
        );
      }
      return json({ board: board(), id });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'add failed', 400);
    }
  }

  // Usage telemetry: GET current bucket capacities; POST a manual calibration.
  if (pathname === '/api/taskq/usage') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    void ingestRunsFromJsonl(); // fire-and-forget; next poll sees the result
    return json({ buckets: allBucketStates(getTaskqDb(), Date.now()) });
  }
  if (pathname === '/api/taskq/usage/calibrate') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const body = await readJsonBody<{ key?: string; consumedFraction?: number; limitUnits?: number; resetAt?: number }>(req);
    if (!body?.key || !(USAGE_BUCKETS as readonly string[]).includes(body.key)) {
      return jsonError(`key must be one of ${USAGE_BUCKETS.join(', ')}`, 400);
    }
    if (typeof body.consumedFraction !== 'number' || body.consumedFraction < 0 || body.consumedFraction > 1) {
      return jsonError('consumedFraction must be 0–1', 400);
    }
    try {
      calibrateBucket(getTaskqDb(), body.key, {
        consumedFraction: body.consumedFraction,
        at: Date.now(),
        limitUnits: body.limitUnits,
        resetAt: body.resetAt,
      });
      return json({ buckets: allBucketStates(getTaskqDb(), Date.now()) });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'calibrate failed', 400);
    }
  }

  // History: recent completed tasks + aggregates.
  if (pathname === '/api/taskq/history') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return json(taskqHistory(getTaskqDb()));
  }

  // Drainer status + control (replaces the old Watchdog tab).
  if (pathname === '/api/taskq/drainer') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return json(drainerStatus());
  }
  if (pathname === '/api/taskq/drainer/run') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    runDrainerNow();
    return json({ ok: true, status: drainerStatus() });
  }
  if (pathname === '/api/taskq/drainer/stop' || pathname === '/api/taskq/drainer/resume') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    setDrainerStop(pathname.endsWith('/stop'));
    return json({ ok: true, status: drainerStatus() });
  }
  // launchd watchdog: load/unload + tick interval.
  if (pathname === '/api/taskq/drainer/watchdog') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const body = await readJsonBody<{ action?: string }>(req);
    if (body?.action !== 'load' && body?.action !== 'unload') return jsonError("action must be 'load' or 'unload'", 400);
    const r = setWatchdog(body.action);
    return json({ ok: r.ok, out: r.out, status: drainerStatus() });
  }
  if (pathname === '/api/taskq/drainer/interval') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const body = await readJsonBody<{ seconds?: number }>(req);
    try {
      const r = setWatchdogInterval(Number(body?.seconds));
      return json({ ok: r.ok, out: r.out, interval: currentInterval() });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to set interval', 400);
    }
  }

  // Capacity snapshot: schedule decision + ready-task eligibility.
  if (pathname === '/api/taskq/capacity') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    try {
      return json(capacitySnapshot(getTaskqDb()));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'capacity snapshot failed', 500);
    }
  }

  // Config (the Settings tab): view + patch the editable knobs.
  if (pathname === '/api/taskq/config') {
    if (req.method === 'GET') return json({ config: loadTaskqConfig(), interval: currentInterval() });
    if (req.method === 'POST') {
      const body = await readJsonBody<TaskqConfigPatch>(req);
      if (!body || typeof body !== 'object') return jsonError('a config patch is required', 400);
      try {
        return json({ config: saveTaskqConfig(body), interval: currentInterval() });
      } catch (e) {
        return jsonError(e instanceof Error ? e.message : 'invalid config', 400);
      }
    }
    return jsonError('use GET or POST', 405);
  }

  // Live worker instances (current leases) + release one.
  if (pathname === '/api/taskq/instances') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return json({ instances: liveInstances(getTaskqDb()) });
  }
  const rel = pathname.match(/^\/api\/taskq\/instances\/(\d+)\/release$/);
  if (rel) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    releaseLease(getTaskqDb(), Number(rel[1]));
    return json({ board: board(), instances: liveInstances(getTaskqDb()) });
  }

  // Section collapse preferences: GET returns Record<status, boolean>, POST accepts a patch.
  if (pathname === '/api/taskq/section-prefs') {
    if (req.method === 'GET') {
      const raw = getUiPref(SECTION_PREFS_KEY);
      return json({ prefs: raw ? JSON.parse(raw) : {} });
    }
    if (req.method === 'POST') {
      const body = await readJsonBody<Record<string, boolean>>(req);
      if (!body || typeof body !== 'object') return jsonError('a prefs object is required', 400);
      const current = JSON.parse(getUiPref(SECTION_PREFS_KEY) ?? '{}') as Record<string, boolean>;
      const merged = { ...current, ...body };
      setUiPref(SECTION_PREFS_KEY, JSON.stringify(merged));
      return json({ prefs: merged });
    }
    return jsonError('use GET or POST', 405);
  }

  // Tail the watchdog log.
  if (pathname === '/api/taskq/logs') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    const n = Number(new URL(req.url).searchParams.get('lines') ?? '200');
    return json(tailWatchdogLog(Number.isFinite(n) ? n : 200));
  }

  // Input Queue: open clarification gateways + answering one (releases children).
  if (pathname === '/api/taskq/clarifications') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return json({ clarifications: openClarifications(getTaskqDb()) });
  }
  const ans = pathname.match(/^\/api\/taskq\/clarifications\/(\d+)\/answer$/);
  if (ans) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const body = await readJsonBody<{ answer?: string }>(req);
    if (typeof body?.answer !== 'string' || !body.answer.trim()) return jsonError('answer (string) is required', 400);
    try {
      resolveGateway(getTaskqDb(), Number(ans[1]), body.answer);
      return json({ board: board(), clarifications: openClarifications(getTaskqDb()) });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'answer failed', 400);
    }
  }

  // /api/taskq/tasks/:id  (+ /status, /move)
  const m = pathname.match(/^\/api\/taskq\/tasks\/(\d+)(\/status|\/move)?$/);
  if (m) {
    const id = Number(m[1]);
    const sub = m[2];
    try {
      if (!sub) {
        if (req.method === 'PATCH') {
          const body = await readJsonBody<{ patch?: TaskPatch }>(req);
          if (!body?.patch || typeof body.patch !== 'object') return jsonError('a { patch } is required', 400);
          updateTask(getTaskqDb(), id, body.patch);
          return json({ board: board() });
        }
        if (req.method === 'DELETE') {
          deleteTask(getTaskqDb(), id);
          return json({ board: board() });
        }
        return jsonError('use PATCH or DELETE', 405);
      }
      if (sub === '/status') {
        if (req.method !== 'POST') return jsonError('use POST', 405);
        const body = await readJsonBody<{ status?: string; note?: string }>(req);
        if (!body?.status || !(TASK_STATUSES as readonly string[]).includes(body.status)) {
          return jsonError(`status must be one of ${TASK_STATUSES.join(', ')}`, 400);
        }
        setStatus(getTaskqDb(), id, body.status as TaskStatus, body.note);
        return json({ board: board() });
      }
      // /move
      if (req.method !== 'POST') return jsonError('use POST', 405);
      const body = await readJsonBody<{ position?: Position }>(req);
      if (!body?.position) return jsonError('a { position } is required', 400);
      moveTask(getTaskqDb(), id, body.position);
      return json({ board: board() });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'taskq write failed', 400);
    }
  }

  return jsonError(`not found: ${pathname}`, 404);
}
