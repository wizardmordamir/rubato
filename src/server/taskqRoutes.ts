/**
 * Taskq (v2 orchestrator) API — CRUD over the SQLite queue for the board/builder.
 * The engine (cwip/taskq) is the authority (validation, atomic writes); these
 * routes just open the handle, call it, and return the rebuilt board. Run-side
 * verbs (claim/complete) aren't here — the orchestrator/CLI own those.
 *
 *   GET    /api/taskq                               → TaskqBoard
 *   GET    /api/taskq/capacity                      → CapacitySnapshot
 *   GET    /api/taskq/serial-groups                 → { groups: string[] }
 *   POST   /api/taskq/tasks                         → add  { draft, position? } → { board, id }
 *   POST   /api/taskq/tasks/bulk-serial-group       → { ids, serial_group } → { board }
 *   PATCH  /api/taskq/tasks/:id                     → update { patch } → { board }
 *   DELETE /api/taskq/tasks/:id                     → { board }
 *   POST   /api/taskq/tasks/:id/status              → { status, note? } → { board }
 *   POST   /api/taskq/tasks/:id/move                → { position } → { board }
 *   POST   /api/taskq/tasks/:id/enqueue             → clone a template into a ready one-shot → { board, id }
 *   GET    /api/taskq/findings                      → { findings, summary } (?status= ?type= ?severity= ?open=1)
 *   POST   /api/taskq/findings/:id/status           → { status, note? } → { findings, summary }
 *   POST   /api/taskq/healer                        → HealerResult (detect + fix stalled states)
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  addTask,
  allBucketStates,
  calibrateBucket,
  deleteTask,
  type FindingSeverity,
  findingsSummary,
  getNeeds,
  getTask,
  isFindingStatus,
  listDrainRuns,
  listFindings,
  listSerialGroups,
  listTasks,
  modelAliasFromId,
  moveTask,
  type NewTask,
  openClarifications,
  type Position,
  recordRun,
  releaseLease,
  setFindingStatus,
  setSerialGroup,
  setStatus,
  TASK_STATUSES,
  type TaskPatch,
  type TaskStatus,
  USAGE_BUCKETS,
  updateTask,
} from 'cwip/taskq';
import { parseRunsJsonl } from '../lib/orchestration';
import type { TaskqBoard } from '../shared/taskq';
import { getUiPref, setUiPref } from './db';
import { json, jsonError, readJsonBody } from './http';
import { notesDir } from './orchestration';
import { capacitySnapshot } from './taskq/capacity';
import { probeClaudeCapacity } from './taskq/claudeExecutor';
import { loadTaskqConfig, saveTaskqConfig, type TaskqConfigPatch } from './taskq/config';
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
import { logHealerResult, makeHealerDeps, runHealer } from './taskq/drainHealer';
import { coerceTaskText } from './taskq/normalizeTask';
import { resolveGateway } from './taskq/triage';
import { applyUsagePollConfig, getUsageSnapshot, refreshUsageNow } from './taskq/usagePoller';
import { reconcileUsageObservation } from './taskq/usageReconcile';
import { getTaskqDb } from './taskqDb';

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

/** Config knobs that change what/how a drain pass runs (vs. pure UI/telemetry). */
const EXECUTION_KNOBS: (keyof TaskqConfigPatch)[] = [
  'jobs',
  'fleet',
  'model',
  'think',
  'fast',
  'leaseTtlMs',
  'taskTimeoutMs',
];

/**
 * After a settings change, kick a drain pass immediately so the new config takes
 * effect now instead of waiting up to a full watchdog interval for the next
 * launchd tick — the "after I change settings, nothing starts" gap. Only when an
 * execution knob actually changed AND the watchdog is loaded, the drainer isn't
 * explicitly stopped, and none is already running (a live drain re-reads jobs/
 * fleet itself each tick, so it needs no kick; model/think/fast apply on its next
 * launch). Best-effort and non-fatal: a failed kick must never fail the save.
 */
function maybeKickDrainer(patch: TaskqConfigPatch): void {
  try {
    if (process.env.TASKQ_NO_AUTOKICK === '1') return; // tests set this — never spawn a real drain
    if (!EXECUTION_KNOBS.some((k) => patch[k] !== undefined)) return;
    const st = drainerStatus();
    if (!st.watchdogLoaded || st.stopped || st.running) return;
    runDrainerNow();
  } catch {
    // never let an auto-kick break the config save
  }
}

/** Rebuild the whole board (tasks + needs + per-status counts + runtime data). */
function board(): TaskqBoard {
  const db = getTaskqDb();
  backfillNumericSlugs(db);

  // Lease data for claimed tasks (claimed_at + heartbeat_at keyed by task_id).
  const leases = db.query(`SELECT task_id, claimed_at, heartbeat_at FROM leases`).all() as {
    task_id: number;
    claimed_at: number;
    heartbeat_at: number;
  }[];
  const leaseByTaskId = new Map(leases.map((l) => [l.task_id, l]));

  // Most-recent completion row per done task.
  type CompRow = {
    task_id: number;
    started_at: number | null;
    ended_at: number;
    duration_s: number | null;
    summary: string | null;
    commit: string | null;
  };
  const completions = db
    .query(
      `SELECT task_id, started_at, ended_at, duration_s, summary, "commit" FROM completions ORDER BY ended_at DESC`,
    )
    .all() as CompRow[];
  const completionByTaskId = new Map<number, CompRow>();
  for (const c of completions) {
    if (!completionByTaskId.has(c.task_id)) completionByTaskId.set(c.task_id, c);
  }

  const tasks = listTasks(db)
    .map((t) => {
      const base = { ...t, needs: getNeeds(db, t.id) };
      if (t.status === 'claimed') {
        const lease = leaseByTaskId.get(t.id);
        return { ...base, claimed_at: lease?.claimed_at ?? null, heartbeat_at: lease?.heartbeat_at ?? null };
      }
      // Include last-completion data for done tasks AND for saved tasks sitting in
      // on_hold after a successful run — so the UI can show "last run Jun 15" and
      // the AI summary rather than showing nothing about why the task is parked there.
      if (t.status === 'done' || (t.status === 'on_hold' && t.is_saved)) {
        const c = completionByTaskId.get(t.id);
        if (c)
          return {
            ...base,
            started_at: c.started_at,
            ended_at: c.ended_at,
            duration_s: c.duration_s,
            summary: c.summary,
            commit: c.commit,
          };
      }
      return base;
    })
    // Coerce every text column to a string so a malformed row (e.g. a note written as a
    // spread Buffer → `{0:65,…}`) can never reach the UI as an object and white-screen the
    // whole board (#304). Pure + unit-tested in taskq/normalizeTask.test.ts.
    .map(coerceTaskText);

  // Sort on_hold tasks newest-first so a freshly-parked task surfaces at the top,
  // not buried below older on_hold items ordered by id.
  const sorted = tasks.slice().sort((a, b) => {
    if (a.status === 'on_hold' && b.status === 'on_hold') return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
    return 0;
  });

  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of sorted) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { tasks: sorted, counts, total: sorted.length };
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
          id,
          id,
          id,
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
    const body = await readJsonBody<{ key?: string; consumedFraction?: number; limitUnits?: number; resetAt?: number }>(
      req,
    );
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

  // Self-heal: fire ONE real probe to learn whether we're actually out of tokens,
  // then adaptively recalibrate the estimate. The "I'm not actually out — re-check"
  // button (and the empty-queue path in the drainer) hit this. No manual numbers.
  if (pathname === '/api/taskq/usage/probe') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    try {
      const probe = await probeClaudeCapacity();
      const db = getTaskqDb();
      let actions: ReturnType<typeof reconcileUsageObservation> = [];
      if (probe.rateLimited) actions = reconcileUsageObservation(db, 'exhausted');
      else if (probe.ok) actions = reconcileUsageObservation(db, 'not-exhausted');
      return json({ probe, reconciled: actions, buckets: allBucketStates(db, Date.now()) });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'probe failed', 500);
    }
  }

  // Live usage telemetry: real `/usage` limits + behavioral diagnostics + the
  // ccusage daily cost/token breakdown, each with a live/fallback status. The
  // background poller keeps this fresh; the buckets endpoint above already
  // reflects the auto-calibration this drives.
  if (pathname === '/api/taskq/usage/live') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return json(getUsageSnapshot());
  }
  if (pathname === '/api/taskq/usage/refresh') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    return json(await refreshUsageNow());
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
    if (body?.action !== 'load' && body?.action !== 'unload')
      return jsonError("action must be 'load' or 'unload'", 400);
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

  // Self-healer: detect + fix stalled drain states (cwip dist, symlinks, drain stall, expired leases).
  if (pathname === '/api/taskq/healer') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    try {
      const db = (() => {
        try {
          return getTaskqDb();
        } catch {
          return undefined;
        }
      })();
      const result = runHealer(makeHealerDeps(db));
      logHealerResult(result);
      return json(result);
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'healer failed', 500);
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
        const config = saveTaskqConfig(body);
        applyUsagePollConfig(); // pick up any usage poll-interval change immediately
        maybeKickDrainer(body); // start a pass now if an execution knob changed while idle
        return json({ config, interval: currentInterval() });
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

  // Serial groups: list distinct names in the queue.
  if (pathname === '/api/taskq/serial-groups') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return json({ groups: listSerialGroups(getTaskqDb()) });
  }

  // Bulk-assign serial_group on a set of task ids (or clear with null).
  if (pathname === '/api/taskq/tasks/bulk-serial-group') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const body = await readJsonBody<{ ids?: unknown; serial_group?: unknown }>(req);
    if (!Array.isArray(body?.ids) || !body.ids.every((x) => typeof x === 'number')) {
      return jsonError('ids (number[]) is required', 400);
    }
    if (body.serial_group !== null && typeof body.serial_group !== 'string') {
      return jsonError('serial_group must be a string or null', 400);
    }
    const name = typeof body.serial_group === 'string' ? body.serial_group.trim() : null;
    try {
      setSerialGroup(getTaskqDb(), body.ids as number[], name);
      return json({ board: board() });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'bulk serial group failed', 400);
    }
  }

  // Drain run audit log: recent drain pass decisions + outcomes.
  if (pathname === '/api/taskq/drain-runs') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit') ?? '50');
    return json(listDrainRuns(getTaskqDb(), Number.isFinite(limit) ? limit : 50));
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

  // Enqueue: clone a template into a ready one-shot task.
  const enqm = pathname.match(/^\/api\/taskq\/tasks\/(\d+)\/enqueue$/);
  if (enqm) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const id = Number(enqm[1]);
    try {
      const db = getTaskqDb();
      const tmpl = getTask(db, id);
      if (!tmpl) return jsonError(`task ${id} not found`, 404);
      if (!tmpl.is_template) return jsonError('task is not a template', 400);
      const copy: NewTask = {
        title: tmpl.title,
        status: 'ready',
        body: tmpl.body ?? undefined,
        model: tmpl.model ?? undefined,
        think: tmpl.think ?? undefined,
        repo: tmpl.repo ?? undefined,
        group_key: tmpl.group_key ?? undefined,
        serial_group: tmpl.serial_group ?? undefined,
        note: undefined,
        is_template: false,
      };
      const newId = addTask(db, copy, { at: 'bottom' });
      return json({ board: board(), id: newId });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'enqueue failed', 400);
    }
  }

  // Duplicate: clone any task into a fresh owner DRAFT (never auto-claimed until
  // the owner queues it). The copy carries the authoring content but not the
  // unique slug or the saved/template/recurrence wiring — it's a clean editable
  // draft, placed right after the original.
  const dupm = pathname.match(/^\/api\/taskq\/tasks\/(\d+)\/duplicate$/);
  if (dupm) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const id = Number(dupm[1]);
    try {
      const db = getTaskqDb();
      const src = getTask(db, id);
      if (!src) return jsonError(`task ${id} not found`, 404);
      const copy: NewTask = {
        title: src.title,
        status: 'draft',
        body: src.body ?? undefined,
        model: src.model ?? undefined,
        think: src.think ?? undefined,
        repo: src.repo ?? undefined,
        group_key: src.group_key ?? undefined,
        serial_group: src.serial_group ?? undefined,
        noop_ok: src.noop_ok === 1,
        needs: getNeeds(db, id),
      };
      const newId = addTask(db, copy, { at: 'after', anchorId: id });
      return json({ board: board(), id: newId });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'duplicate failed', 400);
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
        const body = await readJsonBody<{ status?: string; note?: string | null }>(req);
        if (!body?.status || !(TASK_STATUSES as readonly string[]).includes(body.status)) {
          return jsonError(`status must be one of ${TASK_STATUSES.join(', ')}`, 400);
        }
        const db = getTaskqDb();
        // When re-queuing to ready, clear any stale hold/failure note unless the
        // caller explicitly passed one. This prevents an old failure reason from
        // persisting on a task that's been re-queued for a fresh run.
        const noteArg: string | null | undefined =
          body.note !== undefined ? body.note : body.status === 'ready' ? null : undefined;
        setStatus(db, id, body.status as TaskStatus, noteArg);
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

  // Continuous-improvement findings ledger: list + summary (read), and owner triage
  // (accept/wontfix/reopen/start/fix) by setting a finding's status.
  if (pathname === '/api/taskq/findings') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    try {
      const url = new URL(req.url);
      const status = url.searchParams.get('status') ?? undefined;
      const type = url.searchParams.get('type') ?? undefined;
      const severity = url.searchParams.get('severity') ?? undefined;
      const db = getTaskqDb();
      const findings = listFindings(db, {
        openOnly: url.searchParams.get('open') === '1',
        status: status && isFindingStatus(status) ? status : undefined,
        type: type || undefined,
        severity: (severity as FindingSeverity) || undefined,
      });
      return json({ findings, summary: findingsSummary(db) });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to read findings', 500);
    }
  }
  const fst = pathname.match(/^\/api\/taskq\/findings\/(\d+)\/status$/);
  if (fst) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const id = Number(fst[1]);
    const body = await readJsonBody<{ status?: string; note?: string | null }>(req);
    if (!body?.status || !isFindingStatus(body.status)) {
      return jsonError('status must be one of open, in_progress, fixed, accepted, wontfix', 400);
    }
    try {
      const db = getTaskqDb();
      setFindingStatus(db, id, body.status, body.note ?? undefined);
      return json({ findings: listFindings(db), summary: findingsSummary(db) });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'findings write failed', 400);
    }
  }

  return jsonError(`not found: ${pathname}`, 404);
}
