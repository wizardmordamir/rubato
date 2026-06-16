import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DRAIN_MODEL_OPTIONS, FLEET_MODEL_OPTIONS, type FleetTier, formatDuration, formatUsd, THINKING_LEVELS } from "@shared/orchestration";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  applyFleetPreset,
  controlWatchdogAgent,
  type ActiveRun,
  deleteFleetPreset,
  type DrainConfigPatch,
  fetchFleetPresets,
  fetchLogTail,
  fetchWatchdog,
  type FleetPreset,
  patchDrainConfig,
  type PendingChange,
  restartDrainer,
  saveFleetPreset,
  setWatchdogInterval,
  startDrainer,
  stopDrainer,
  stopInstance,
  type ThinkingLevel,
  wakeWorkers,
  type WatchdogCommand,
  type WatchdogSnapshot,
  type WorkerInstance,
  type WorkerProcess,
} from "../api";
import {
  Alert,
  Badge,
  BTN_DANGER_CLASS,
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  FIELD_CLASS,
  OpenPathButton,
  PathRef,
  Spinner,
  Switch,
  Tooltip,
} from "../components";
import { CopyButton } from "cwip/react";
import { IconPlay, IconSquare, IconTrash, IconZap } from "../icons";
import { useToast } from "../toast";

/**
 * The Watchdog control tab — start/stop/pace the headless `claude -p` queue
 * drainer + its launchd watchdog, and observe what it's doing: live in-progress
 * instances (with elapsed timers), workers, problems, the next tick, the tunable
 * knobs (max instances, thinking level, fast mode, tick interval), tailable logs,
 * editor-linked file locations, and a manual shell-command catalogue.
 *
 * Reads/writes go through `/api/orchestration/watchdog…`; the snapshot polls
 * every few seconds so the dashboard feels live without a websocket.
 */
export function WatchdogView() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ["watchdog"],
    queryFn: fetchWatchdog,
    refetchInterval: 4000,
  });

  // A 1s tick so elapsed timers and the next-check countdown advance live.
  const nowMs = useNowMs();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["watchdog"] });
    qc.invalidateQueries({ queryKey: ["orchestration"] });
  };

  if (isLoading) return <p className="text-gray-400">loading…</p>;
  if (isError || !data)
    return (
      <p className="text-red-600 dark:text-red-400">
        Failed to load watchdog state: {error instanceof Error ? error.message : "unknown error"}
      </p>
    );

  return (
    <div className="space-y-6">
      <ControlBar snap={data} onChange={invalidate} refetching={isFetching} onRefetch={() => refetch()} />
      <StatGrid snap={data} nowMs={nowMs} />
      <ScheduleCard snap={data} nowMs={nowMs} onChange={invalidate} />
      <KnobsCard snap={data} onChange={invalidate} />
      <InstancesSection snap={data} nowMs={nowMs} onChange={invalidate} />
      {data.problems.length > 0 && <ProblemsSection snap={data} />}
      <ReadyQueue snap={data} />
      <LogsSection snap={data} />
      <FilesSection snap={data} />
      <CommandsSection commands={data.commands} />
    </div>
  );
}

// ── live "now" tick ───────────────────────────────────────────────────────────

function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Live elapsed seconds from an ISO start against `nowMs` (fallback to server value). */
function elapsedFrom(startedAt: string | undefined, nowMs: number, fallback: number | undefined): number | undefined {
  if (startedAt) {
    const t = Date.parse(startedAt);
    if (!Number.isNaN(t)) return Math.max(0, Math.round((nowMs - t) / 1000));
  }
  return fallback;
}

// ── control bar (start / stop / pause-resume) ─────────────────────────────────

function ControlBar({
  snap,
  onChange,
  refetching,
  onRefetch,
}: {
  snap: WatchdogSnapshot;
  onChange: () => void;
  refetching: boolean;
  onRefetch: () => void;
}) {
  const { notify } = useToast();
  const start = useMutation({
    mutationFn: () => startDrainer(),
    onSuccess: (r) => {
      notify(r.started ? `Drainer started (PID ${r.pid})` : r.error || "could not start", r.started ? "success" : "error");
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "action failed", "error"),
  });
  const stop = useMutation({
    mutationFn: () => stopDrainer(),
    onSuccess: (r) => {
      notify(r.stopped ? `Stopped drainer + ${r.workerPids.length} worker(s)` : r.reason || "nothing running", r.stopped ? "success" : "info");
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "action failed", "error"),
  });
  const wake = useMutation({
    mutationFn: () => wakeWorkers(),
    onSuccess: (r) => {
      if (r.action === "noop") notify(r.message || "Workers already at capacity", "info");
      else if (!r.started) notify(r.error || "could not wake workers", "error");
      else {
        const n = `${r.jobs} worker${r.jobs === 1 ? "" : "s"}`;
        if (r.action === "restart")
          notify(`Relaunched at ${n}${r.killed?.length ? ` (stopped ${r.killed.length})` : ""}`, "success");
        else notify(`Started ${n}${r.pid ? ` (PID ${r.pid})` : ""}`, "success");
      }
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "action failed", "error"),
  });
  const pause = useMutation({
    mutationFn: (enabled: boolean) => patchDrainConfig({ enabled }),
    onSuccess: (r) => {
      notify(r.config.enabled ? "Watchdog resumed" : "Watchdog paused", "success");
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "action failed", "error"),
  });
  const restart = useMutation({
    mutationFn: (mode: "graceful" | "force") => restartDrainer(mode),
    onSuccess: (r) => {
      if (!r.ok) notify(r.error || "restart failed", "error");
      else if (r.mode === "force")
        notify(r.willRestart ? `Force-restarted${r.startedPid ? ` (PID ${r.startedPid})` : ""}` : "Force-stopped", "success");
      else notify("Graceful restart queued — finishes the current task, then relaunches", "success");
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "action failed", "error"),
  });
  const setAutoRestart = useMutation({
    mutationFn: (on: boolean) => patchDrainConfig({ autoRestart: on }),
    onSuccess: (r) => {
      notify(r.config.autoRestart ? "Auto-restart on" : "Auto-restart off", "success");
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "action failed", "error"),
  });

  // There's something to stop when the runner is up OR any worker is still alive.
  const canStop = snap.running || snap.workers.some((w) => w.alive);
  // Restart targets a live drain (otherwise "Start" is the right action).
  const canRestart = snap.running;
  const pendingCount = snap.pending.length;
  // A drainer is up but short-handed: fewer live workers than the configured
  // fan-out (some exited, or JOBS was raised after it started). "Wake workers"
  // is the fix, so it lights up (primary) instead of staying a quiet ghost.
  const liveWorkers = snap.workers.filter((w) => w.alive).length;
  const shortHanded = snap.running && liveWorkers < snap.config.jobs;

  return (
    <div className={`${CARD_CLASS} flex flex-wrap items-center gap-3 p-3`}>
      <span className="inline-flex items-center gap-1.5 font-medium">
        {snap.running ? (
          <>
            <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500" />
            <span className="text-emerald-600 dark:text-emerald-400">Draining</span>
            {snap.runnerPid && <span className="text-xs text-gray-400">PID {snap.runnerPid}</span>}
          </>
        ) : (
          <>
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-gray-400" />
            <span className="text-gray-500">Idle</span>
          </>
        )}
      </span>

      <Badge tone={snap.config.enabled ? "success" : "neutral"}>
        Watchdog {snap.config.enabled ? "armed" : "paused"}
      </Badge>

      {pendingCount > 0 && (
        <Tooltip
          content={`These saved settings differ from what the running drainer launched with — they apply on the next launch. Restart to apply now:\n${snap.pending
            .map((p) => `• ${p.label}: ${p.running || "—"} → ${p.saved || "—"}`)
            .join("\n")}`}
          multiline
        >
          <Badge tone="warn">
            ● {pendingCount} pending — restart to apply
          </Badge>
        </Tooltip>
      )}

      <Tooltip multiline content="Auto-restart: when on, changing a needs-restart setting (jobs, model, thinking, fast mode, dirs) while a drain is running triggers a graceful restart automatically so it takes effect. When off, the change is saved but stays pending until the next launch.">
        <span className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300">
          <Switch
            on={!!snap.config.autoRestart}
            disabled={setAutoRestart.isPending}
            onChange={(v) => setAutoRestart.mutate(v)}
            label="Auto-restart"
          />
          Auto-restart
        </span>
      </Tooltip>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {/* Start and Stop are mutually-exclusive "live" actions: whichever one
            applies to the current state is the bright/colored button, the other
            looks disabled — so the row visibly reacts as the drain starts/stops.
            Both show a pending label the instant they're clicked. */}
        <Tooltip multiline content="Start a new drain run now. The drainer launches headless claude -p workers to claim and complete tasks from TASKS.md. It self-locks so a second start while one runs just exits — safe to click even if unsure whether it's already running.">
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={start.isPending || snap.running}
            className={BTN_PRIMARY_CLASS}
          >
            {start.isPending ? <Spinner /> : <IconPlay size={14} />}
            {start.isPending ? "Starting…" : snap.running ? "Drain running" : "Start drain"}
          </button>
        </Tooltip>
        <Tooltip multiline content="Stop the drainer and all its live workers. Sends a targeted signal by PID — never a blanket kill. In-flight tasks are interrupted and return to the queue as resumable (they pick up where they left off on next start).">
          {/* Solid red while there's something to stop; falls back to a (clearly
              disabled) ghost button once nothing is running. */}
          <button
            type="button"
            onClick={() => stop.mutate()}
            disabled={stop.isPending || !canStop}
            className={canStop ? BTN_DANGER_CLASS : BTN_GHOST_CLASS}
          >
            {stop.isPending ? <Spinner /> : <IconSquare size={13} />}
            {stop.isPending ? "Stopping…" : canStop ? "Stop drain" : "Stopped"}
          </button>
        </Tooltip>
        <Tooltip multiline content="Bring live workers up to the configured job count (JOBS). Starts a drainer if none is running; relaunches a short-handed one when fewer workers are alive than configured (e.g. some exited early or JOBS was raised). Any in-flight task resumes in its worktree. Lights up when the drainer is running with fewer workers than expected.">
          <button
            type="button"
            onClick={() => wake.mutate()}
            disabled={wake.isPending}
            className={shortHanded ? BTN_PRIMARY_CLASS : BTN_GHOST_CLASS}
          >
            {wake.isPending ? <Spinner /> : <IconZap size={13} />}{" "}
            {wake.isPending
              ? "Waking…"
              : shortHanded
                ? `Wake ${snap.config.jobs - liveWorkers} worker${snap.config.jobs - liveWorkers === 1 ? "" : "s"}`
                : "Wake workers"}
          </button>
        </Tooltip>
        <Tooltip multiline content="Graceful restart: the drainer finishes its current task, then a fresh drainer relaunches with the latest saved settings (jobs, model, thinking, fast mode, dirs). No work is lost. Use this after changing a tuning knob that needs a restart to apply. Lights up when there are pending changes.">
          <button
            type="button"
            onClick={() => restart.mutate("graceful")}
            disabled={restart.isPending || !canRestart}
            className={canRestart && pendingCount > 0 ? BTN_PRIMARY_CLASS : BTN_GHOST_CLASS}
          >
            {restart.isPending && restart.variables === "graceful" && <Spinner />}
            {restart.isPending && restart.variables === "graceful" ? "Restarting…" : "Restart"}
          </button>
        </Tooltip>
        <Tooltip multiline content="Force restart: immediately kill the drainer and all workers (SIGKILL to the process group, sweeping all claude -p children), then relaunch. Use only when a graceful restart is stuck — the in-flight task is interrupted and returns to the queue as resumable.">
          <button
            type="button"
            onClick={() => restart.mutate("force")}
            disabled={restart.isPending || !canRestart}
            className={canRestart ? BTN_DANGER_CLASS : BTN_GHOST_CLASS}
          >
            {restart.isPending && restart.variables === "force" && <Spinner />}
            {restart.isPending && restart.variables === "force" ? "Forcing…" : "Force"}
          </button>
        </Tooltip>
        <Tooltip multiline content="Pause or resume the launchd watchdog's scheduled auto-launch. Pausing keeps the agent loaded (it still ticks) but blocks it from starting new drains — use it to hold the queue without fully unloading the agent. Resume re-arms it so the next tick can launch a drain.">
          <button
            type="button"
            onClick={() => pause.mutate(!snap.config.enabled)}
            disabled={pause.isPending}
            className={BTN_GHOST_CLASS}
          >
            {pause.isPending && <Spinner />}
            {pause.isPending ? "Saving…" : snap.config.enabled ? "Pause watchdog" : "Resume watchdog"}
          </button>
        </Tooltip>
        <Tooltip multiline content="Manually poll the watchdog snapshot right now. This panel auto-refreshes every 4 seconds, so you rarely need this — use it for an immediate update right after issuing a command.">
          <button type="button" onClick={onRefetch} disabled={refetching} className={BTN_GHOST_CLASS}>
            {refetching && <Spinner />}
            {refetching ? "Refreshing…" : "Refresh"}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

// ── stat grid ─────────────────────────────────────────────────────────────────

function StatGrid({ snap, nowMs }: { snap: WatchdogSnapshot; nowMs: number }) {
  const liveWorkers = snap.workers.filter((w) => w.alive).length;
  const nextIn = snap.nextRunAt ? Math.round((Date.parse(snap.nextRunAt) - nowMs) / 1000) : undefined;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Stat label="Ready" value={String(snap.counts.ready)} tone={snap.counts.ready > 0 ? "accent" : undefined} />
      <Stat label="In progress" value={String(snap.instances.length)} />
      <Stat label="Blocked" value={String(snap.counts.blocked)} tone={snap.counts.blocked > 0 ? "error" : undefined} />
      <Stat
        label="Workers live"
        value={`${liveWorkers}/${snap.config.jobs}`}
        tone={snap.running && liveWorkers < snap.config.jobs ? "warn" : undefined}
      />
      <Stat
        label="Tick interval"
        value={snap.launchd.intervalSeconds ? formatDuration(snap.launchd.intervalSeconds) : "—"}
      />
      <Stat
        label="Next check"
        value={
          snap.resumeAt
            ? "paused"
            : nextIn === undefined
              ? "—"
              : nextIn <= 0
                ? "due"
                : formatDuration(nextIn)
        }
        tone={snap.resumeAt ? "warn" : undefined}
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "accent" | "error" | "warn" }) {
  const valueColor =
    tone === "accent"
      ? "text-accent"
      : tone === "error"
        ? "text-red-600 dark:text-red-400"
        : tone === "warn"
          ? "text-amber-600 dark:text-amber-400"
          : "";
  return (
    <div className={`${CARD_CLASS} p-3`}>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${valueColor}`}>{value}</p>
    </div>
  );
}

// ── launchd agent lifecycle + schedule (last run / next run / custom resume) ──

/** Format a sub-second tick duration in ms; ≥1s falls back to the seconds formatter. */
function fmtTickDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return formatDuration(Math.round(ms / 1000));
}

/** Format a Date as a `datetime-local` value (`YYYY-MM-DDTHH:mm`, in LOCAL time). */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The launchd-agent + schedule card: load/unload/reload the watchdog agent itself,
 * show its last tick (time + duration) and the effective next action, and set a
 * custom "don't resume until" time (RESUME_AT). Pairs the agent's hard lifecycle
 * with the soft ENABLED/RESUME_AT scheduling so the whole "when does it run next"
 * story lives in one place.
 */
function ScheduleCard({ snap, nowMs, onChange }: { snap: WatchdogSnapshot; nowMs: number; onChange: () => void }) {
  const { notify } = useToast();
  const loaded = snap.launchd.loaded; // true / false / undefined (couldn't query)

  const agent = useMutation({
    mutationFn: (action: "start" | "stop" | "restart") => controlWatchdogAgent(action),
    onSuccess: (r) => {
      notify(r.ok ? r.message || `Watchdog ${r.action}ed` : r.error || `could not ${r.action} the agent`, r.ok ? "success" : "error");
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "action failed", "error"),
  });

  const schedule = useMutation({
    // Setting a resume time arms the watchdog (enabled) so the resume can fire.
    mutationFn: (resumeAt: number) =>
      resumeAt > 0 ? patchDrainConfig({ enabled: true, resumeAt }) : patchDrainConfig({ resumeAt: 0 }),
    onSuccess: (_r, resumeAt) => {
      notify(resumeAt > 0 ? "Resume time set" : "Resume time cleared", "success");
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  // The datetime-local input: default to ~1h out, but mirror a pending resume.
  const [pickValue, setPickValue] = useState("");
  useEffect(() => {
    setPickValue(snap.resumeAt ? toLocalInput(new Date(snap.resumeAt)) : "");
  }, [snap.resumeAt]);

  const applyResume = (epochMs: number) => {
    const epoch = Math.floor(epochMs / 1000);
    if (!Number.isFinite(epoch) || epoch * 1000 <= nowMs) {
      notify("Pick a time in the future", "error");
      return;
    }
    schedule.mutate(epoch);
  };

  // Quick presets, computed against the server's "now" for consistency.
  const presets = useMemo(() => buildSchedulePresets(nowMs), [nowMs]);

  const agentTone = loaded === true ? "success" : loaded === false ? "error" : "neutral";
  const agentLabel = loaded === true ? "loaded" : loaded === false ? "not loaded" : "unknown";

  // The effective next-action line.
  const next = nextActionLabel(snap, nowMs);

  return (
    <div className={`${CARD_CLASS} space-y-4 p-4`}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Agent &amp; schedule</h3>
        <Tooltip
          content="The launchd agent is the OS-level timer that ticks every interval and (when armed) launches a drain. 'loaded' = launchd is ticking it; 'not loaded' = stopped entirely. This is separate from Pause/Resume (which keeps it loaded but stops it launching drains)."
          multiline
        >
          <Badge tone={agentTone}>launchd agent {agentLabel}</Badge>
        </Tooltip>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Tooltip multiline content="Load the launchd watchdog agent (launchctl load -w) so it resumes ticking on its schedule. Use this after Stop agent or when the agent isn't registered with macOS yet.">
            <button
              type="button"
              onClick={() => agent.mutate("start")}
              disabled={agent.isPending || loaded === true}
              className={loaded === true ? BTN_GHOST_CLASS : BTN_PRIMARY_CLASS}
            >
              {agent.isPending && agent.variables === "start" ? <Spinner /> : <IconPlay size={13} />}
              {agent.isPending && agent.variables === "start" ? "Starting…" : "Start agent"}
            </button>
          </Tooltip>
          <Tooltip multiline content="Reload the launchd agent (unload then load) — picks up a changed plist or unsticks a misbehaving agent without altering the tick interval. Safe to run while the agent is loaded.">
            <button
              type="button"
              onClick={() => agent.mutate("restart")}
              disabled={agent.isPending}
              className={BTN_GHOST_CLASS}
            >
              {agent.isPending && agent.variables === "restart" && <Spinner />}
              {agent.isPending && agent.variables === "restart" ? "Reloading…" : "Reload agent"}
            </button>
          </Tooltip>
          <Tooltip multiline content="Unload the launchd agent (launchctl unload -w) so it stops ticking entirely and won't auto-launch drains. It stays stopped until you Start it again. Use this for a hard stop when Pause watchdog (which keeps the agent loaded) isn't enough.">
            <button
              type="button"
              onClick={() => agent.mutate("stop")}
              disabled={agent.isPending || loaded === false}
              className={loaded === false ? BTN_GHOST_CLASS : BTN_DANGER_CLASS}
            >
              {agent.isPending && agent.variables === "stop" ? <Spinner /> : <IconSquare size={12} />}
              {agent.isPending && agent.variables === "stop" ? "Stopping…" : "Stop agent"}
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Last run */}
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">Last tick</p>
          {snap.lastRun?.startedAt ? (
            <Tooltip content={`${snap.lastRun.startedAt}${snap.lastRun.result ? ` · ${snap.lastRun.result}` : ""}`}>
              <p className="text-sm">
                <span className="font-medium tabular-nums">{fmtTime(snap.lastRun.startedAt)}</span>
                <span className="text-gray-400"> · took {fmtTickDuration(snap.lastRun.durationMs)}</span>
                {snap.lastRun.result && <span className="text-gray-400"> · {snap.lastRun.result}</span>}
              </p>
            </Tooltip>
          ) : (
            <p className="text-sm text-gray-400">no tick recorded yet</p>
          )}
        </div>

        {/* Next run (effective action) */}
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">Next run</p>
          <p className={`text-sm font-medium ${next.tone}`}>{next.text}</p>
        </div>

        {/* Tick interval (read-only mirror; editable in Tuning below) */}
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">Tick interval</p>
          <p className="text-sm tabular-nums">
            {snap.launchd.intervalSeconds ? formatDuration(snap.launchd.intervalSeconds) : "—"}
          </p>
        </div>
      </div>

      {/* Custom next start time (RESUME_AT) */}
      <div className="border-t border-gray-100 pt-3 dark:border-gray-800">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Custom next start time</p>
          <Tooltip
            content="Hold the watchdog idle until a chosen time, then let it resume on its own. It keeps ticking but won't launch a drain until then (stored as RESUME_AT in drain.config; pausing the watchdog clears it). Setting a time also arms the watchdog."
            multiline
          >
            <span className="cursor-help text-xs text-gray-400">ⓘ</span>
          </Tooltip>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="datetime-local"
            value={pickValue}
            min={toLocalInput(new Date(nowMs))}
            onChange={(e) => setPickValue(e.target.value)}
            className={`${FIELD_CLASS} w-56`}
          />
          <button
            type="button"
            className={BTN_PRIMARY_CLASS}
            disabled={schedule.isPending || !pickValue}
            onClick={() => pickValue && applyResume(new Date(pickValue).getTime())}
          >
            {schedule.isPending && <Spinner />}
            {schedule.isPending ? "Saving…" : "Set resume time"}
          </button>
          {snap.resumeAt && (
            <button
              type="button"
              className={BTN_GHOST_CLASS}
              disabled={schedule.isPending}
              onClick={() => schedule.mutate(0)}
            >
              {schedule.isPending ? <Spinner /> : <IconTrash size={13} />} Clear
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              disabled={schedule.isPending}
              onClick={() => applyResume(p.at)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {snap.resumeAt && loaded === false && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            A resume time is set but the launchd agent isn't loaded — Start the agent above so it can resume.
          </p>
        )}
      </div>
    </div>
  );
}

/** Quick "resume at" presets, computed against the server's `nowMs`. */
function buildSchedulePresets(nowMs: number): { label: string; at: number }[] {
  const at = (d: Date) => d.getTime();
  const plusHours = (h: number) => nowMs + h * 3600_000;
  // Today at HH:mm local; roll to tomorrow if that's already past.
  const todayAt = (h: number, m: number) => {
    const d = new Date(nowMs);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return at(d);
  };
  return [
    { label: "+1h", at: plusHours(1) },
    { label: "+4h", at: plusHours(4) },
    { label: "This evening (5:30pm)", at: todayAt(17, 30) },
    { label: "Tomorrow 8am", at: todayAt(8, 0) },
  ];
}

/** The effective "next run" line: agent stopped / disabled / paused-resume / scheduled. */
function nextActionLabel(snap: WatchdogSnapshot, nowMs: number): { text: string; tone: string } {
  if (snap.launchd.loaded === false) return { text: "agent stopped — start it to schedule", tone: "text-red-600 dark:text-red-400" };
  if (!snap.config.enabled) return { text: "— (watchdog paused)", tone: "text-gray-400" };
  if (snap.resumeAt) {
    const inMs = Date.parse(snap.resumeAt) - nowMs;
    const within = inMs > 0 ? ` (in ${formatDuration(Math.round(inMs / 1000))})` : "";
    return { text: `paused — resumes ${fmtTime(snap.resumeAt)}${within}`, tone: "text-amber-600 dark:text-amber-400" };
  }
  if (snap.nextRunAt) {
    const inS = Math.round((Date.parse(snap.nextRunAt) - nowMs) / 1000);
    return { text: inS <= 0 ? "next tick due" : `next tick in ${formatDuration(inS)}`, tone: "" };
  }
  return { text: "—", tone: "text-gray-400" };
}

// ── tunable knobs — flat mode (single model) or fleet mode (per-model tiers) ─────

/** Dot color for a model alias — keeps the fleet table visually scannable. */
function modelDotClass(alias: string): string {
  switch (alias) {
    case "opus":
    case "opus-1m":
      return "bg-purple-500";
    case "sonnet":
      return "bg-blue-500";
    case "haiku":
      return "bg-green-500";
    case "fable":
      return "bg-pink-500";
    default:
      return "bg-gray-400";
  }
}

/** One editable fleet tier row. */
function FleetTierRow({
  tier,
  onChange,
  onRemove,
  disabled,
}: {
  tier: FleetTier;
  onChange: (t: FleetTier) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_auto_minmax(0,1fr)_auto_auto] items-center gap-2">
      {/* Model */}
      <div className="flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${modelDotClass(tier.modelAlias)}`} />
        <select
          className={`${FIELD_CLASS} flex-1 text-sm`}
          value={tier.modelAlias}
          disabled={disabled}
          onChange={(e) => onChange({ ...tier, modelAlias: e.target.value })}
        >
          {FLEET_MODEL_OPTIONS.map((m) => (
            <option key={m.alias} value={m.alias}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {/* Slots stepper */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={BTN_GHOST_CLASS}
          disabled={disabled || tier.slots <= 1}
          onClick={() => onChange({ ...tier, slots: Math.max(1, tier.slots - 1) })}
        >
          −
        </button>
        <span className="w-6 text-center text-sm font-bold tabular-nums">{tier.slots}</span>
        <button
          type="button"
          className={BTN_GHOST_CLASS}
          disabled={disabled || tier.slots >= 8}
          onClick={() => onChange({ ...tier, slots: Math.min(8, tier.slots + 1) })}
        >
          +
        </button>
      </div>
      {/* Thinking cap */}
      <Tooltip content="Max thinking level for this tier. Tasks asking for more are capped here." multiline>
        <select
          className={`${FIELD_CLASS} text-sm`}
          value={tier.thinkingLevel}
          disabled={disabled}
          onChange={(e) => onChange({ ...tier, thinkingLevel: e.target.value as FleetTier["thinkingLevel"] })}
        >
          {THINKING_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </Tooltip>
      {/* Fast mode toggle */}
      <Tooltip content="/fast mode for this tier's workers" multiline>
        <div className="flex items-center gap-1">
          <Switch on={tier.fastMode} disabled={disabled} onChange={(v) => onChange({ ...tier, fastMode: v })} label="Fast" />
          <span className="text-xs text-gray-500">{tier.fastMode ? "fast" : ""}</span>
        </div>
      </Tooltip>
      {/* Remove */}
      <button
        type="button"
        className="rounded p-1 text-gray-400 hover:text-red-500 disabled:opacity-40"
        disabled={disabled}
        title="Remove tier"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

function KnobsCard({ snap, onChange }: { snap: WatchdogSnapshot; onChange: () => void }) {
  const { notify } = useToast();
  const patch = useMutation({
    mutationFn: (p: DrainConfigPatch) => patchDrainConfig(p),
    onSuccess: (r) => {
      if (r.autoRestart?.stopRequested) notify("Saved — auto-restarting to apply", "success");
      else notify("Saved", "success");
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const pendingByKey = useMemo(
    () => new Map<string, PendingChange>(snap.pending.map((p) => [p.key, p])),
    [snap.pending],
  );

  const isFleetMode = Boolean(snap.config.fleetTiers?.length);

  // Fleet draft state (only used in fleet mode).
  const [fleetDraft, setFleetDraft] = useState<FleetTier[]>(snap.config.fleetTiers ?? []);
  useEffect(() => setFleetDraft(snap.config.fleetTiers ?? []), [snap.config.fleetTiers]);
  const fleetDirty = JSON.stringify(fleetDraft) !== JSON.stringify(snap.config.fleetTiers ?? []);
  const fleetTotal = fleetDraft.reduce((s, t) => s + t.slots, 0);

  // Flat mode — single-model knobs.
  const modelValue = snap.config.model ?? "claude-opus-4-8";
  const modelOptions = DRAIN_MODEL_OPTIONS.some((m) => m.id === modelValue)
    ? DRAIN_MODEL_OPTIONS
    : [...DRAIN_MODEL_OPTIONS, { id: modelValue, label: modelValue }];
  const jobs = snap.config.jobs;
  const setJobs = (n: number) => patch.mutate({ jobs: Math.max(1, Math.min(8, n)) });

  const [interval, setIntervalInput] = useState(String(snap.launchd.intervalSeconds ?? 60));
  useEffect(() => setIntervalInput(String(snap.launchd.intervalSeconds ?? 60)), [snap.launchd.intervalSeconds]);
  const applyInterval = useMutation({
    mutationFn: (seconds: number) => setWatchdogInterval(seconds),
    onSuccess: (r) => {
      notify(r.reloaded ? `Interval → ${r.intervalSeconds}s (reloaded)` : `Interval → ${r.intervalSeconds}s (${r.reloadError ?? "reload skipped"})`, r.reloaded ? "success" : "info");
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "failed", "error"),
  });

  const switchToFleet = () => {
    // Migrate current flat settings to a single fleet tier.
    const alias = FLEET_MODEL_OPTIONS.find((m) => m.id === (snap.config.model ?? "claude-opus-4-8"))?.alias ?? "opus";
    patch.mutate({
      fleetTiers: [{ modelAlias: alias, slots: snap.config.jobs, thinkingLevel: snap.config.thinkingLevel ?? "off", fastMode: snap.config.fastMode ?? false }],
    });
  };
  const switchToFlat = () => patch.mutate({ fleetTiers: null });

  // The worker-mix to capture when "Save current as a fleet": the live fleet tiers in
  // fleet mode, otherwise the flat knobs distilled into a single equivalent tier.
  const flatAlias = FLEET_MODEL_OPTIONS.find((m) => m.id === (snap.config.model ?? "claude-opus-4-8"))?.alias ?? "opus";
  const currentTiers: FleetTier[] = isFleetMode
    ? fleetDraft
    : [
        {
          modelAlias: flatAlias,
          slots: snap.config.jobs,
          thinkingLevel: snap.config.thinkingLevel ?? "off",
          fastMode: snap.config.fastMode ?? false,
        },
      ];

  return (
    <div className={`${CARD_CLASS} space-y-5 p-4`}>
      <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Tuning</h3>

      {isFleetMode ? (
        /* ── Fleet mode ── */
        <div className="space-y-3">
          {/* Fleet header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Fleet</span>
              {pendingByKey.get("fleetTiers") && (
                <Tooltip
                  content={`Fleet config changed since the running drainer launched. Restart to apply.`}
                  multiline
                >
                  <span className="text-xs font-medium text-amber-600 dark:text-amber-400">● pending — restart to apply</span>
                </Tooltip>
              )}
            </div>
            <span className="text-xs text-gray-500">{fleetTotal} worker{fleetTotal !== 1 ? "s" : ""} total</span>
          </div>

          {/* Column headers */}
          <div className="grid grid-cols-[minmax(0,2fr)_auto_minmax(0,1fr)_auto_auto] gap-2 border-b border-gray-200 pb-1 dark:border-gray-700">
            <span className="text-xs text-gray-500">Model</span>
            <span className="text-xs text-gray-500">Slots</span>
            <span className="text-xs text-gray-500">Thinking cap</span>
            <span className="text-xs text-gray-500">Fast</span>
            <span />
          </div>

          {/* Tier rows */}
          <div className="space-y-2">
            {fleetDraft.map((tier, i) => (
              <FleetTierRow
                key={i}
                tier={tier}
                disabled={patch.isPending}
                onChange={(updated) => setFleetDraft(fleetDraft.map((t, j) => (j === i ? updated : t)))}
                onRemove={() => setFleetDraft(fleetDraft.filter((_, j) => j !== i))}
              />
            ))}
          </div>

          {/* Add tier */}
          <button
            type="button"
            className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 disabled:opacity-40"
            disabled={patch.isPending || fleetDraft.length >= 8}
            onClick={() =>
              setFleetDraft([
                ...fleetDraft,
                { modelAlias: "sonnet", slots: 1, thinkingLevel: "off", fastMode: false },
              ])
            }
          >
            + Add tier
          </button>

          {/* Apply button (shown when draft differs from saved) */}
          {fleetDirty && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={BTN_PRIMARY_CLASS}
                disabled={patch.isPending || fleetDraft.length === 0}
                onClick={() => patch.mutate({ fleetTiers: fleetDraft })}
              >
                {patch.isPending && <Spinner />}
                {patch.isPending ? "Saving…" : "Apply fleet"}
              </button>
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                disabled={patch.isPending}
                onClick={() => setFleetDraft(snap.config.fleetTiers ?? [])}
              >
                Discard
              </button>
            </div>
          )}

          {/* Help + mode toggle */}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Each tier spawns its own workers. Workers claim tasks tagged{" "}
            <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">(model:X)</code> matching their model, or any untagged task.
            The thinking cap is the max budget — tasks asking for more are clamped.
          </p>
          <button
            type="button"
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            disabled={patch.isPending}
            onClick={switchToFlat}
          >
            ← Back to flat mode
          </button>
        </div>
      ) : (
        /* ── Flat mode ── */
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Max instances */}
            <Field
              label="Max instances (jobs)"
              hint="Concurrent task-workers the next drain fans out to. ~2–4 is the practical laptop ceiling. Fixed at launch — changing it needs a restart to apply."
              pending={pendingByKey.get("jobs")}
            >
              <div className="flex items-center gap-2">
                <button type="button" className={BTN_GHOST_CLASS} disabled={patch.isPending || jobs <= 1} onClick={() => setJobs(jobs - 1)}>
                  −
                </button>
                <span className="w-8 text-center text-lg font-bold tabular-nums">{jobs}</span>
                <button type="button" className={BTN_GHOST_CLASS} disabled={patch.isPending || jobs >= 8} onClick={() => setJobs(jobs + 1)}>
                  +
                </button>
              </div>
            </Field>

            {/* Model */}
            <Field
              label="Model"
              hint="Default worker model for the next drain (per-task (model:) markers in TASKS.md override it). Opus = deepest, Sonnet/Haiku = cheaper/faster. Fixed at launch — changing it needs a restart to apply."
              pending={pendingByKey.get("model")}
            >
              <select
                className={FIELD_CLASS}
                value={modelValue}
                disabled={patch.isPending}
                onChange={(e) => patch.mutate({ model: e.target.value })}
              >
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>

            {/* Thinking level */}
            <Field
              label="Thinking level"
              hint="Extended-thinking budget per run (maps to MAX_THINKING_TOKENS). Higher = deeper but slower/pricier. Fixed at launch — changing it needs a restart to apply."
              pending={pendingByKey.get("thinkingLevel")}
            >
              <select
                className={FIELD_CLASS}
                value={snap.config.thinkingLevel ?? "off"}
                disabled={patch.isPending}
                onChange={(e) => patch.mutate({ thinkingLevel: e.target.value as ThinkingLevel })}
              >
                {THINKING_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>

            {/* Fast mode */}
            <Field
              label="Fast mode (/fast)"
              hint="Request Claude's faster-output Opus mode (~2.5× faster) for each run — applied by the drainer on its next launch. It's a paid research preview (higher cost, billed from usage credits), so leave it off unless a run is speed-sensitive. Fixed at launch — changing it needs a restart to apply."
              pending={pendingByKey.get("fastMode")}
            >
              <div className="flex items-center gap-2 pt-1">
                <Switch on={!!snap.config.fastMode} disabled={patch.isPending} onChange={(v) => patch.mutate({ fastMode: v })} label="Fast mode" />
                <span className="text-sm text-gray-500">{snap.config.fastMode ? "on" : "off"}</span>
              </div>
            </Field>
          </div>

          {/* Switch to fleet */}
          <Tooltip
            content="Fleet mode lets you configure separate worker pools for each model — e.g. 1 Opus worker and 2 Sonnet workers, each with their own thinking cap. Workers only pick tasks tagged with their model (or untagged tasks)."
            multiline
          >
            <button
              type="button"
              className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 disabled:opacity-40"
              disabled={patch.isPending}
              onClick={switchToFleet}
            >
              Switch to fleet mode →
            </button>
          </Tooltip>
        </div>
      )}

      {/* Saved fleets — name a worker-mix and swap to it in one click */}
      <FleetPresetsPanel snap={snap} onChange={onChange} currentTiers={currentTiers} busy={patch.isPending} />

      {/* Watchdog interval — always shown */}
      <div className="border-t border-gray-200 pt-4 dark:border-gray-700">
        <Field label="Watchdog interval (s)" hint="How often the launchd watchdog ticks (StartInterval). Applied + reloaded immediately.">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={interval}
              onChange={(e) => setIntervalInput(e.target.value)}
              className={`${FIELD_CLASS} w-24`}
            />
            <button
              type="button"
              className={BTN_PRIMARY_CLASS}
              disabled={applyInterval.isPending || !Number.isFinite(Number(interval)) || Number(interval) < 1}
              onClick={() => applyInterval.mutate(Number(interval))}
            >
              {applyInterval.isPending && <Spinner />}
              {applyInterval.isPending ? "Applying…" : "Apply"}
            </button>
          </div>
          <div className="mt-1 flex gap-1">
            {[60, 300, 900].map((s) => (
              <button
                key={s}
                type="button"
                className="rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
                onClick={() => applyInterval.mutate(s)}
              >
                {s === 60 ? "1m" : `${s / 60}m`}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </div>
  );
}

/** A compact tier summary like "1× Opus · 2× Sonnet". */
function summarizeTiers(tiers: FleetTier[]): string {
  return tiers
    .map((t) => `${t.slots}× ${FLEET_MODEL_OPTIONS.find((m) => m.alias === t.modelAlias)?.label ?? t.modelAlias}`)
    .join(" · ");
}

/** A stable key for tier equality — used to flag which saved fleet is currently live. */
function tiersKey(tiers: FleetTier[]): string {
  return tiers.map((t) => `${t.modelAlias},${t.slots},${t.thinkingLevel},${t.fastMode ? 1 : 0}`).join("|");
}

/**
 * Saved fleets: name a worker-mix (e.g. "Strong", "Fast", "Slow") and swap to it in
 * one click. "Save current" captures the mix shown in the Tuning editor above; "Apply"
 * writes a preset's tiers into drain.config (auto-restarting to take effect when armed).
 */
function FleetPresetsPanel({
  snap,
  onChange,
  currentTiers,
  busy,
}: {
  snap: WatchdogSnapshot;
  onChange: () => void;
  currentTiers: FleetTier[];
  busy: boolean;
}) {
  const { notify } = useToast();
  const qc = useQueryClient();
  const { data: presets = [], isLoading } = useQuery({ queryKey: ["fleet-presets"], queryFn: fetchFleetPresets });
  const [name, setName] = useState("");

  const setList = (list: FleetPreset[]) => qc.setQueryData(["fleet-presets"], list);

  const save = useMutation({
    mutationFn: () => saveFleetPreset({ name: name.trim(), tiers: currentTiers }),
    onSuccess: (list) => {
      setList(list);
      setName("");
      notify("Fleet saved", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });
  const apply = useMutation({
    mutationFn: (id: string) => applyFleetPreset(id),
    onSuccess: (r) => {
      notify(
        r.autoRestart?.stopRequested ? `Applied "${r.preset.name}" — restarting to take effect` : `Applied "${r.preset.name}"`,
        "success",
      );
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "apply failed", "error"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteFleetPreset(id),
    onSuccess: (list) => {
      setList(list);
      notify("Fleet deleted", "info");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "delete failed", "error"),
  });

  const activeKey = snap.config.fleetTiers?.length ? tiersKey(snap.config.fleetTiers) : null;
  const canSave = name.trim().length > 0 && currentTiers.length > 0 && !save.isPending;

  return (
    <div className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Saved fleets</span>
        <span className="text-xs text-gray-500">
          {presets.length} saved
        </span>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Name a worker-mix (e.g. <em>Strong</em>, <em>Fast</em>, <em>Slow</em>) and swap to it in one click. Applying a fleet writes its
        tiers into the drainer config — auto-restarting to take effect when that's armed.
      </p>

      {isLoading ? (
        <p className="text-xs text-gray-400">loading…</p>
      ) : presets.length === 0 ? (
        <p className="text-xs text-gray-400">No saved fleets yet — set the tiers above, then save the current mix below.</p>
      ) : (
        <div className="space-y-2">
          {presets.map((p) => {
            const isActive = activeKey !== null && tiersKey(p.tiers) === activeKey;
            const total = p.tiers.reduce((s, t) => s + t.slots, 0);
            return (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 rounded border border-gray-200 px-3 py-2 dark:border-gray-700"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{p.name}</span>
                    {isActive && <Badge tone="success">active</Badge>}
                  </div>
                  <div className="truncate text-xs text-gray-500">
                    {summarizeTiers(p.tiers)} · {total} worker{total !== 1 ? "s" : ""}
                  </div>
                  {p.note && <div className="truncate text-xs text-gray-400">{p.note}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className={BTN_PRIMARY_CLASS}
                    disabled={isActive || apply.isPending || busy}
                    onClick={() => apply.mutate(p.id)}
                  >
                    {apply.isPending && apply.variables === p.id && <Spinner />}
                    {isActive ? "Applied" : "Apply"}
                  </button>
                  <Tooltip content="Delete this saved fleet">
                    <button
                      type="button"
                      className={BTN_GHOST_CLASS}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(p.id)}
                      aria-label={`Delete ${p.name}`}
                    >
                      <IconTrash />
                    </button>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={name}
          placeholder="Name this fleet (e.g. Strong)"
          className={`${FIELD_CLASS} flex-1`}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) save.mutate();
          }}
        />
        <Tooltip content={`Save the mix shown above — ${summarizeTiers(currentTiers)}`} multiline>
          <button type="button" className={BTN_PRIMARY_CLASS} disabled={!canSave} onClick={() => save.mutate()}>
            {save.isPending && <Spinner />}
            {save.isPending ? "Saving…" : "Save current"}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  pending,
  children,
}: {
  label: string;
  hint?: string;
  /** When set, this setting's saved value differs from the running drainer → show a "restart to apply" marker. */
  pending?: PendingChange;
  children: ReactNode;
}) {
  return (
    <div>
      {hint ? (
        <Tooltip content={hint} multiline>
          <p className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">
            {label}
          </p>
        </Tooltip>
      ) : (
        <p className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">{label}</p>
      )}
      {children}
      {pending && (
        <Tooltip
          content={`Saved as “${pending.saved || "—"}”, but the running drainer launched with “${pending.running || "—"}”. Restart the drainer to apply it.`}
          multiline
        >
          <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">
            ● pending — restart to apply
          </p>
        </Tooltip>
      )}
    </div>
  );
}

// ── in-progress instances + workers ───────────────────────────────────────────

function InstancesSection({ snap, nowMs, onChange }: { snap: WatchdogSnapshot; nowMs: number; onChange: () => void }) {
  const { notify } = useToast();
  const stop = useMutation({
    mutationFn: (pid: number) => stopInstance(pid),
    onSuccess: (r) => {
      notify(r.stopped ? `Stopped worker PID ${r.pid}` : r.error || "could not stop", r.stopped ? "success" : "error");
      onChange();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "failed", "error"),
  });

  // Denominator for "worker N/total" — the configured fan-out, but never less than
  // the number of worker PID files actually present.
  const totalWorkers = Math.max(snap.config.jobs, snap.workers.length);

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        In progress <span className="text-gray-400">({snap.instances.length})</span>
      </h3>
      {snap.instances.length === 0 ? (
        <p className="text-sm text-gray-400">No tasks are claimed (no `[~]` entries on the board).</p>
      ) : (
        <div className="space-y-2">
          {snap.instances.map((inst) => (
            <InstanceCard key={inst.line} inst={inst} nowMs={nowMs} totalWorkers={totalWorkers} activeRun={snap.activeRun} />
          ))}
        </div>
      )}

      {snap.workers.length > 0 && (
        <WorkerProcesses snap={snap} nowMs={nowMs} onStop={(pid) => stop.mutate(pid)} stopPending={stop.isPending} activeRun={snap.activeRun} />
      )}
    </section>
  );
}

/**
 * The "Worker processes" block — a one-line live/working summary (so the gap
 * between live workers and workers actually on a task is obvious at a glance), a
 * diagnostic note when workers sit unlinked while work is queued, then one
 * expandable row per worker.
 */
function WorkerProcesses({
  snap,
  nowMs,
  onStop,
  stopPending,
  activeRun,
}: {
  snap: WatchdogSnapshot;
  nowMs: number;
  onStop: (pid: number) => void;
  stopPending: boolean;
  activeRun?: ActiveRun;
}) {
  const live = snap.workers.filter((w) => w.alive);
  const working = live.filter((w) => snap.instances.some((i) => i.worker === w.id)).length;
  const unlinked = live.length - working;
  // One-off-slug tasks (descriptive worktree, no `_drain-w<n>`) can't be tied to a
  // worker row — call them out so an "unlinked" worker reads as "maybe on one of
  // these" rather than "idle". This is the usual reason for live > working.
  const oneOffTasks = snap.instances.filter((i) => i.worker === undefined).length;

  return (
    <div className="mt-3">
      <h4 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Worker processes
        <span className="font-normal normal-case tracking-normal text-gray-400">
          {live.length} live · {working} on a task
          {unlinked > 0 ? ` · ${unlinked} unlinked` : ""}
        </span>
      </h4>
      {unlinked > 0 && snap.counts.ready > 0 && (
        <Alert tone="warning" size="sm" className="mb-2">
          {unlinked} live worker{unlinked === 1 ? "" : "s"} not linked to a claimed task while {snap.counts.ready}{" "}
          {snap.counts.ready === 1 ? "task is" : "tasks are"} ready.{" "}
          {oneOffTasks > 0
            ? `${oneOffTasks} in-progress task${oneOffTasks === 1 ? " is" : "s are"} on a one-off-slug worktree (shown above, can't link to a slot) — likely what they're doing. `
            : ""}
          A worker also reads as unlinked during its pre-claim phase (planning before it stamps a “[~]”). Expand a row
          to see when it last finished and whether its last run errored.
        </Alert>
      )}
      <div className="space-y-1.5">
        {snap.workers.map((w) => (
          <WorkerRow
            key={w.pid}
            worker={w}
            instance={snap.instances.find((i) => i.worker === w.id)}
            readyCount={snap.counts.ready}
            nowMs={nowMs}
            onStop={() => onStop(w.pid)}
            stopPending={stopPending}
            activeRun={activeRun}
          />
        ))}
      </div>
    </div>
  );
}

// ── per-worker activity status (working / starting / idle / …) ─────────────────

type WorkerStatus = "working" | "starting" | "retrying" | "idle" | "draining" | "exited";

const STATUS_CHIP: Record<WorkerStatus, string> = {
  working: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  starting: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  retrying: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  idle: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  draining: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  exited: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

/** A worker is "freshly finished" (so an unlinked one is between tasks, not stuck). */
const WORKER_RECENT_FINISH_SECONDS = 120;

/** Seconds since a worker's last task finished, if known. */
function idleSeconds(w: WorkerProcess, nowMs: number): number | undefined {
  if (!w.lastFinishedAt) return undefined;
  const t = Date.parse(w.lastFinishedAt);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.round((nowMs - t) / 1000));
}

/**
 * Classify what a worker is doing right now, from whether a claimed task links to
 * its slot plus its run history. The interesting case is alive-but-unlinked: fresh
 * after a finish (or no tasks yet) reads as "starting" (normal pre-claim), a recent
 * error reads as "retrying" (likely in failure backoff), and a stale finish while
 * work is queued reads as "idle" (worth a look). Drives the row's status chip + hint.
 */
function workerActivity(
  w: WorkerProcess,
  instance: WorkerInstance | undefined,
  readyCount: number,
  nowMs: number,
): { status: WorkerStatus; label: string; hint: string } {
  if (!w.alive) return { status: "exited", label: "exited", hint: "Process is no longer running." };
  if (instance) return { status: "working", label: "working", hint: `Working on “${instance.title}”.` };
  const idle = idleSeconds(w, nowMs);
  if (w.lastTaskErrored)
    return {
      status: "retrying",
      label: "retrying",
      hint: "Its last run reported an error — the drainer backs off (a short sleep that grows with consecutive failures) before retrying, so it may pause here. Check its .err output below.",
    };
  if (!w.tasksCompleted || (idle !== undefined && idle < WORKER_RECENT_FINISH_SECONDS))
    return {
      status: "starting",
      label: "starting",
      hint: "Between tasks — its next run is in the pre-claim phase (reading the board / planning) and hasn’t stamped a “[~]” claim yet. This is normal; it links to a task once it claims one.",
    };
  if (readyCount > 0)
    return {
      status: "idle",
      label: "idle",
      hint: "Alive but not linked to a claimed task while work is queued — it may be on a one-off-slug task (shown above), in a long pre-claim phase, or stuck. Check its run log / .err output.",
    };
  return {
    status: "draining",
    label: "no ready tasks",
    hint: "Alive with no claimed task and nothing ready — it will exit once the queue is empty.",
  };
}

/** Format a millisecond duration via the shared seconds formatter. */
function fmtMs(ms: number | undefined): string {
  return formatDuration(ms === undefined ? undefined : Math.round(ms / 1000));
}

/**
 * One in-progress task card — title, repo/worker/worktree/started metadata, the
 * live elapsed timer, and an expandable view of the task's body text from TASKS.md
 * so you can read exactly what's being worked on without leaving the dashboard.
 */
function InstanceCard({
  inst,
  nowMs,
  totalWorkers,
  activeRun,
}: {
  inst: WorkerInstance;
  nowMs: number;
  totalWorkers: number;
  activeRun?: ActiveRun;
}) {
  const [open, setOpen] = useState(false);
  const elapsed = elapsedFrom(inst.startedAt, nowMs, inst.elapsedSeconds);
  // Effective model/thinking for this task: per-task override takes priority,
  // then the drainer's launch settings, then the saved config default.
  const effectiveModel = inst.model ?? activeRun?.model;
  const effectiveThinking = inst.thinkingLevel ?? (activeRun?.thinkingLevel || undefined);
  return (
    <div className={`${CARD_CLASS} p-3`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{inst.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
            {inst.repo && <Badge tone="accent">{inst.repo}</Badge>}
            {inst.worker !== undefined && (
              <Badge tone="neutral">
                worker {inst.worker}
                {totalWorkers > 0 ? `/${totalWorkers}` : ""}
              </Badge>
            )}
            {effectiveModel && (
              <Tooltip content={inst.model ? "Per-task model override from (model:) heading marker" : "Drainer's default model for this session"} multiline>
                <span className="font-mono">{effectiveModel}{inst.model && <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">override</span>}</span>
              </Tooltip>
            )}
            {effectiveThinking && effectiveThinking !== "off" && (
              <Tooltip content={inst.thinkingLevel ? "Per-task thinking-level override from (think:) heading marker" : "Drainer's default thinking level for this session"} multiline>
                <span>think: <span className="font-mono">{effectiveThinking}{inst.thinkingLevel && <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">override</span>}</span></span>
              </Tooltip>
            )}
            {inst.worktree && (
              <span>
                worktree: <span className="font-mono">{inst.worktree}</span>
              </span>
            )}
            {inst.startedAt && <Tooltip content={inst.startedAt}><span>since {fmtTime(inst.startedAt)}</span></Tooltip>}
            <span className="text-gray-400">TASKS.md line {inst.line}</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-lg font-bold tabular-nums text-accent">{formatDuration(elapsed)}</p>
          <p className="text-xs text-gray-400">working</p>
        </div>
      </div>
      {inst.body && (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mt-2 text-xs text-accent hover:underline"
          >
            {open ? "Hide task details" : "Show task details"}
          </button>
          {open && (
            <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-950 dark:text-gray-300">
              {inst.body}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One worker-process row — click it to expand what it's working on (the matched
 * in-progress task), how long it's been on that task, its uptime, and how many
 * tasks it has finished this session. The Stop button is kept inline.
 */
function WorkerRow({
  worker: w,
  instance,
  readyCount,
  nowMs,
  onStop,
  stopPending,
  activeRun,
}: {
  worker: WorkerProcess;
  instance?: WorkerInstance;
  readyCount: number;
  nowMs: number;
  onStop: () => void;
  stopPending: boolean;
  activeRun?: ActiveRun;
}) {
  const [open, setOpen] = useState(false);
  const uptime = typeof w.elapsedSeconds === "number" ? formatDuration(elapsedFrom(w.startedAt, nowMs, w.elapsedSeconds)) : undefined;
  const activity = workerActivity(w, instance, readyCount, nowMs);
  const idle = idleSeconds(w, nowMs);
  // Derive when the last task STARTED (finished − duration) so the row can show its
  // full window even though only the finish time + duration are reported.
  const lastStartedAt =
    w.lastFinishedAt && w.lastDurationMs !== undefined
      ? new Date(Date.parse(w.lastFinishedAt) - w.lastDurationMs).toISOString()
      : undefined;
  return (
    <div className={`${CARD_CLASS} p-2.5 text-sm`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tooltip content={open ? "Hide worker details" : "Show what this worker is doing"}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
          aria-expanded={open}
        >
          <Badge tone={w.alive ? "success" : "neutral"}>worker {w.id || "?"}</Badge>
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_CHIP[activity.status]}`}
            title={activity.hint}
          >
            {activity.label}
          </span>
          <span className="font-mono text-gray-500">PID {w.pid}</span>
          {activeRun?.model && (
            <span className="font-mono text-xs text-gray-400">{activeRun.model}</span>
          )}
          {activeRun?.thinkingLevel && activeRun.thinkingLevel !== "" && activeRun.thinkingLevel !== "off" && (
            <span className="text-xs text-gray-400">think: {activeRun.thinkingLevel}</span>
          )}
          {typeof w.tasksCompleted === "number" && (
            <span className="text-xs text-gray-400">{w.tasksCompleted} done</span>
          )}
          {w.avgDurationMs !== undefined && <span className="text-xs text-gray-400">avg {fmtMs(w.avgDurationMs)}</span>}
          {w.errorCount ? <span className="text-xs text-red-500 dark:text-red-400">{w.errorCount} err</span> : null}
          {uptime && <span className="text-xs text-gray-400">up {uptime}</span>}
          {instance ? (
            <span className="min-w-0 truncate text-xs text-accent">▸ {instance.title}</span>
          ) : (
            w.alive && idle !== undefined && <span className="text-xs text-gray-400">idle {formatDuration(idle)}</span>
          )}
        </button>
        </Tooltip>
        {w.alive && (
          <button
            type="button"
            className={`${BTN_GHOST_CLASS} shrink-0 text-red-600 dark:text-red-400`}
            disabled={stopPending}
            onClick={onStop}
          >
            <IconTrash size={13} /> Stop
          </button>
        )}
      </div>
      {open && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-gray-100 pt-2 text-xs text-gray-500 dark:border-gray-800">
          <dt className="text-gray-400">Status</dt>
          <dd className="min-w-0">{activity.hint}</dd>
          <dt className="text-gray-400">Working on</dt>
          <dd className="min-w-0">
            {instance ? (
              instance.title
            ) : (
              <span className="text-gray-400">— no claimed task is linked to this worker (its worktree isn't a `_drain-w{w.id}` slot)</span>
            )}
          </dd>
          {instance?.startedAt && (
            <>
              <dt className="text-gray-400">Current task started</dt>
              <dd>
                {fmtTime(instance.startedAt)}
                <span className="text-gray-400"> · {formatDuration(elapsedFrom(instance.startedAt, nowMs, instance.elapsedSeconds))} ago</span>
              </dd>
            </>
          )}
          {lastStartedAt && (
            <>
              <dt className="text-gray-400">Last task started</dt>
              <dd>{fmtTime(lastStartedAt)}</dd>
            </>
          )}
          {w.lastFinishedAt && (
            <>
              <dt className="text-gray-400">Last task finished</dt>
              <dd>
                {fmtTime(w.lastFinishedAt)}
                {idle !== undefined && <span className="text-gray-400"> · {formatDuration(idle)} ago</span>}
              </dd>
            </>
          )}
          {w.lastDurationMs !== undefined && (
            <>
              <dt className="text-gray-400">Last task duration</dt>
              <dd>
                {fmtMs(w.lastDurationMs)}
                {w.lastTaskErrored && <span className="text-red-500 dark:text-red-400"> · errored</span>}
              </dd>
            </>
          )}
          {w.avgDurationMs !== undefined && (
            <>
              <dt className="text-gray-400">Avg task duration</dt>
              <dd>{fmtMs(w.avgDurationMs)}</dd>
            </>
          )}
          {uptime && (
            <>
              <dt className="text-gray-400">Worker uptime</dt>
              <dd>{uptime}</dd>
            </>
          )}
          {typeof w.tasksCompleted === "number" && (
            <>
              <dt className="text-gray-400">Tasks done this session</dt>
              <dd>
                {w.tasksCompleted}
                {w.errorCount ? <span className="text-red-500 dark:text-red-400"> · {w.errorCount} errored</span> : null}
              </dd>
            </>
          )}
          {w.totalCostUsd !== undefined && (
            <>
              <dt className="text-gray-400">Session cost</dt>
              <dd>{formatUsd(w.totalCostUsd)}</dd>
            </>
          )}
          {activeRun?.model && (
            <>
              <dt className="text-gray-400">Model</dt>
              <dd className="font-mono">{activeRun.model}</dd>
            </>
          )}
          {activeRun?.thinkingLevel !== undefined && activeRun.thinkingLevel !== "" && (
            <>
              <dt className="text-gray-400">Thinking level</dt>
              <dd className="font-mono">{activeRun.thinkingLevel || "off"}</dd>
            </>
          )}
          {w.logFile && (
            <>
              <dt className="text-gray-400">Run log</dt>
              <dd className="min-w-0 truncate font-mono">{w.logFile}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

// ── problems ──────────────────────────────────────────────────────────────────

function ProblemsSection({ snap }: { snap: WatchdogSnapshot }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Problems &amp; questions <span className="text-gray-400">({snap.problems.length})</span>
      </h3>
      <div className="space-y-2">
        {snap.problems.map((p, i) => (
          <Alert
            key={`${p.kind}-${i}`}
            tone={p.severity === "error" ? "error" : "warning"}
            title={p.title}
            actions={<Badge tone={p.severity === "error" ? "error" : "neutral"}>{p.kind}</Badge>}
          >
            {p.detail ? <p className="whitespace-pre-wrap text-xs text-gray-500">{p.detail}</p> : undefined}
          </Alert>
        ))}
      </div>
    </section>
  );
}

// ── ready queue (what's next) ─────────────────────────────────────────────────

function ReadyQueue({ snap }: { snap: WatchdogSnapshot }) {
  if (snap.readyTitles.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Next up <span className="text-gray-400">({snap.readyTitles.length} ready)</span>
      </h3>
      <ol className={`${CARD_CLASS} divide-y divide-gray-100 dark:divide-gray-800`}>
        {snap.readyTitles.map((t, i) => (
          <li key={`${i}-${t}`} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="w-5 text-right font-mono text-xs text-gray-400">{i + 1}</span>
            <span className="truncate">{t}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── logs (tail a watchdog/run log) ────────────────────────────────────────────

function LogsSection({ snap }: { snap: WatchdogSnapshot }) {
  const [key, setKey] = useState<string>(snap.logs[0]?.key ?? "watchdog-log");
  const [follow, setFollow] = useState(true);
  const { data: tail, isFetching } = useQuery({
    queryKey: ["watchdog-log", key],
    queryFn: () => fetchLogTail(key, 300),
    enabled: !!key,
    refetchInterval: follow ? 3000 : false,
  });

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Logs</h3>
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${FIELD_CLASS} max-w-xs`} value={key} onChange={(e) => setKey(e.target.value)}>
          {snap.logs.map((l) => (
            <option key={l.key} value={l.key} disabled={!l.exists}>
              {l.label}
              {l.exists ? "" : " (empty)"}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-500">
          <Switch on={follow} onChange={setFollow} label="follow" /> follow
        </label>
        {tail?.path && <OpenPathButton path={tail.path} />}
        {isFetching && <span className="text-xs text-gray-400">…</span>}
      </div>
      <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-gray-950 p-3 font-mono text-xs leading-relaxed text-gray-200">
        {tail?.exists ? (
          tail.lines.length ? (
            tail.lines.join("\n")
          ) : (
            "(empty)"
          )
        ) : (
          "(file does not exist yet)"
        )}
      </pre>
      {tail?.exists && (
        <p className="mt-1 text-xs text-gray-400">
          showing last {tail.lines.length} of {tail.totalLines} line(s)
        </p>
      )}
    </section>
  );
}

// ── file locations (editor links) ─────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  workspace: "Workspace",
  board: "Board",
  config: "Config",
  script: "Scripts",
  logs: "Logs",
  docs: "Docs",
};

function FilesSection({ snap }: { snap: WatchdogSnapshot }) {
  const byCategory = useMemo(() => {
    const map = new Map<string, typeof snap.files>();
    for (const f of snap.files) {
      const list = map.get(f.category) ?? [];
      list.push(f);
      map.set(f.category, list);
    }
    return map;
  }, [snap.files]);

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">File locations</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[...byCategory.entries()].map(([cat, files]) => (
          <div key={cat} className={`${CARD_CLASS} p-3`}>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
              {CATEGORY_LABELS[cat] ?? cat}
            </p>
            <ul className="space-y-1.5">
              {files.map((f) => (
                <li key={f.path} className="flex items-start gap-1.5 text-sm">
                  <span
                    aria-hidden
                    className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${f.exists ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600"}`}
                  />
                  <div className="min-w-0">
                    <p className="truncate">{f.label}</p>
                    <PathRef path={f.path} className="text-xs text-gray-400" codeClassName="font-mono text-[11px]" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── shell-command catalogue (copy to run yourself) ────────────────────────────

const COMMAND_GROUPS: { key: WatchdogCommand["category"]; label: string }[] = [
  { key: "observe", label: "Observe" },
  { key: "logs", label: "Logs" },
  { key: "control", label: "Control" },
];

function CommandsSection({ commands }: { commands: WatchdogCommand[] }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Run it yourself</h3>
      <p className="mb-2 text-xs text-gray-500">
        Copy-paste shell commands for manual control + observability (with your real paths).
      </p>
      <div className="space-y-4">
        {COMMAND_GROUPS.map(({ key, label }) => {
          const group = commands.filter((c) => c.category === key);
          if (group.length === 0) return null;
          return (
            <div key={key}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</p>
              <div className="space-y-1.5">
                {group.map((c) => (
                  <CommandRow key={c.id} cmd={c} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CommandRow({ cmd }: { cmd: WatchdogCommand }) {
  const { notify } = useToast();
  return (
    <div className={`${CARD_CLASS} p-2.5`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{cmd.label}</p>
          <p className="text-xs text-gray-500">{cmd.description}</p>
        </div>
        <CopyButton
          text={cmd.command}
          iconSize={13}
          resetMs={1500}
          onCopied={() => notify("Copied", "success")}
          onError={() => notify("Copy failed", "error")}
          className="border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          Copy
        </CopyButton>
      </div>
      <pre className="mt-1.5 overflow-x-auto rounded bg-gray-100 px-2 py-1 font-mono text-xs text-gray-700 dark:bg-gray-950 dark:text-gray-300">
        {cmd.command}
      </pre>
    </div>
  );
}

// ── helper ────────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
