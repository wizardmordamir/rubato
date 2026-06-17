/**
 * Taskq (v2 orchestrator) API — CRUD over the SQLite queue for the board/builder.
 * The engine (cwip/taskq) is the authority (validation, atomic writes); these
 * routes just open the handle, call it, and return the rebuilt board. Run-side
 * verbs (claim/complete) aren't here — the orchestrator/CLI own those.
 *
 *   GET    /api/taskq                      → TaskqBoard
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
  moveTask,
  type NewTask,
  type Position,
  setStatus,
  type TaskPatch,
  TASK_STATUSES,
  type TaskStatus,
  updateTask,
  USAGE_BUCKETS,
} from 'cwip/taskq';
import type { TaskqBoard } from '../shared/taskq';
import { json, jsonError, readJsonBody } from './http';
import { getTaskqDb } from './taskqDb';

/** Rebuild the whole board (tasks + needs + per-status counts). */
function board(): TaskqBoard {
  const db = getTaskqDb();
  const tasks = listTasks(db).map((t) => ({ ...t, needs: getNeeds(db, t.id) }));
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
      const id = addTask(getTaskqDb(), body.draft, body.position ?? { at: 'top' });
      return json({ board: board(), id });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'add failed', 400);
    }
  }

  // Usage telemetry: GET current bucket capacities; POST a manual calibration.
  if (pathname === '/api/taskq/usage') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
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
