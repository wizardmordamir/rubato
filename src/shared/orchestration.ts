/**
 * Wire types for the Orchestration page — the area that configures, tracks, and
 * manages the unattended "drain the task queue" workflows (a headless `claude -p`
 * loop draining `TASKS.md`).
 *
 * Pure data/types only (no runtime imports) so both the rubato server and the UI
 * can import it (the UI via the `@shared` Vite alias). The pure parsers/aggregators
 * that produce these shapes live in `src/lib/orchestration/` (library module — no
 * server/db imports, so the import-boundary guard stays green); the file reads/
 * writes that feed them live in `src/server/orchestration.ts`.
 */

// ── Tasks board (TASKS.md) ────────────────────────────────────────────────────

/** A task's status, mirroring the `[ ]`/`[~]`/`[x]`/`[!]`/`[-]` tag in TASKS.md. */
export type WorkflowTaskStatus = 'ready' | 'claimed' | 'done' | 'blocked' | 'not-ready';

/** The five status groups, in board display order. */
export const WORKFLOW_STATUSES: WorkflowTaskStatus[] = ['ready', 'claimed', 'done', 'blocked', 'not-ready'];

/** Human label for a status group. */
export const WORKFLOW_STATUS_LABELS: Record<WorkflowTaskStatus, string> = {
  ready: 'Ready',
  claimed: 'In progress',
  done: 'Done',
  blocked: 'Blocked',
  'not-ready': 'Not ready',
};

/** One parsed task from the TASKS.md board. */
export interface WorkflowTask {
  /** The `## [x]` heading status. */
  status: WorkflowTaskStatus;
  /** The task title (heading text with the status tag + parenthetical metadata stripped). */
  title: string;
  /** Raw heading line, verbatim (for display / deep-linking). */
  rawHeading: string;
  /** Parenthetical metadata captured from the heading, when present. */
  meta: WorkflowTaskMeta;
  /** The body text under the heading, trimmed (may be empty). */
  body: string;
  /** 1-based line number of the heading in TASKS.md (for jump-to-edit). */
  line: number;
}

/** Metadata stamped in a heading's `(...)` — fields vary by status. */
export interface WorkflowTaskMeta {
  /** Worktree slug, from a `[~]` heading: `(worktree: <slug> · <ISO>)`. */
  worktree?: string;
  /**
   * Resume worktree slug, from a `(resume: <slug>)` marker the watchdog adds when
   * it re-opens a stranded claim — present alongside `worktree` once re-claimed.
   */
  resume?: string;
  /** ISO start, from a `[~]` or `[x]` heading. */
  start?: string;
  /** ISO end, from a `[x]` heading. */
  end?: string;
  /** Duration text, from a `[x]` heading (e.g. `9m 32s`, `~9m`). */
  duration?: string;
  /** Repo name, from a `[x]` heading (e.g. `rubato`). */
  repo?: string;
  /** Short commit hash, from a `[x]` heading. */
  commit?: string;
  /** Blocked reason, from a `[!]` heading: `(needs live Jenkins creds)`. */
  reason?: string;
  /** Per-task model override from a `(model:<id>)` heading marker. */
  model?: string;
  /** Per-task thinking-level override from a `(think:<level>)` heading marker. */
  thinkingLevel?: string;
}

/** The whole parsed board: tasks grouped by status, with per-group counts. */
export interface WorkflowBoard {
  /** Every parsed task, in file order. */
  tasks: WorkflowTask[];
  /** Tasks grouped by status (each in file order). */
  groups: Record<WorkflowTaskStatus, WorkflowTask[]>;
  /** Per-status counts. */
  counts: Record<WorkflowTaskStatus, number>;
  /** Total tasks parsed. */
  total: number;
}

// ── History (Tasks_Completed.md) ──────────────────────────────────────────────

/** One completed-task entry parsed from Tasks_Completed.md. */
export interface HistoryEntry {
  /** The `## <title>` heading text (trailing ` — Claude` author suffix stripped). */
  title: string;
  /** ISO start timestamp, when present. */
  start?: string;
  /** ISO completion timestamp, when present. */
  end?: string;
  /** Raw duration text as written (e.g. `46m 32s`, `~9m`). */
  durationText?: string;
  /** Duration in seconds, parsed from `durationText` (best-effort). */
  durationSeconds?: number;
  /** Repo the work landed in (e.g. `rubato`), when discoverable. */
  repo?: string;
  /** Short commit hash, when discoverable. */
  commit?: string;
  /** 1-based line number of the heading (for reference). */
  line: number;
}

// ── Runs (orchestration/runs/*.jsonl) ─────────────────────────────────────────

/** One `claude -p --output-format json` result, parsed from a runs JSONL line. */
export interface RunEntry {
  /** Which JSONL file this came from (bare name, e.g. `run-20260614-150000.jsonl`). */
  file: string;
  /** The session id, when present. */
  sessionId?: string;
  /** The model used, when present. */
  model?: string;
  /** Total cost in USD, when present. */
  costUsd?: number;
  /** Wall-clock duration in ms, when present. */
  durationMs?: number;
  /** Prompt (input) tokens, when present. */
  inputTokens?: number;
  /** Completion (output) tokens, when present. */
  outputTokens?: number;
  /** Cache-creation input tokens, when present. */
  cacheCreationTokens?: number;
  /** Cache-read input tokens, when present. */
  cacheReadTokens?: number;
  /** Total tokens across input/output/cache (derived). */
  totalTokens?: number;
  /** The run's `result` text (truncated for display). */
  result?: string;
  /** Whether the run reported an error (`is_error`/`subtype`). */
  isError?: boolean;
  /** Best-effort wall-clock time of this line — the file's mtime (ISO). */
  at?: string;
}

/** A live-status view of the runs logs (latest entries + whether one is appending). */
export interface RunStatus {
  /** Whether any runs JSONL exists at all. */
  hasRuns: boolean;
  /** True when a runs file was modified very recently (a run is likely live). */
  live: boolean;
  /** The most-recently-modified runs file (bare name), when any. */
  latestFile?: string;
  /** ISO mtime of the latest file, when any. */
  latestModified?: string;
  /** Total run entries parsed across all files. */
  totalRuns: number;
  /** The most recent N run entries, newest first. */
  recent: RunEntry[];
}

// ── Aggregate stats (history + runs) ──────────────────────────────────────────

/** Per-repo rollup of completed work + run cost. */
export interface RepoStat {
  repo: string;
  /** Completed tasks attributed to this repo. */
  tasks: number;
  /** Summed task duration (seconds) for this repo. */
  durationSeconds: number;
}

/** Aggregate stats across history + runs, for the page's stat cards. */
export interface OrchestrationStats {
  /** Completed tasks (history entries). */
  totalTasks: number;
  /** Total task duration across history (seconds). */
  totalDurationSeconds: number;
  /** Average task duration (seconds), over entries that had a duration. */
  avgDurationSeconds: number;
  /** Total tokens across all run entries (input + output + cache). */
  totalTokens: number;
  /** Total cost (USD) across all run entries. */
  totalCostUsd: number;
  /** Total headless runs ingested. */
  totalRuns: number;
  /** Per-repo breakdown, sorted by task count desc. */
  byRepo: RepoStat[];
}

// ── Docs / config viewer + editor ─────────────────────────────────────────────

/** One editable orchestration doc/config file (allowlisted, server-derived path). */
export interface OrchestrationFileInfo {
  /** Stable key the client sends (never a path). */
  key: string;
  /** Display label. */
  label: string;
  /** Resolved absolute path (for display + "open in editor"). */
  path: string;
  /** Offer a Markdown preview in the editor. */
  markdown: boolean;
  /** Whether the file exists on disk right now. */
  exists: boolean;
}

/** One file's full contents (the editor's load shape). */
export interface OrchestrationFileDoc extends OrchestrationFileInfo {
  content: string;
}

// ── Watchdog / drain control (orchestration/drain.config + watchdog state) ─────

/** Extended-thinking budget level applied to each headless `claude -p` run. */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

/** All thinking levels, low→high (the default `off` first). */
export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

/** Map a thinking level to a `MAX_THINKING_TOKENS` budget the drainer exports. */
export function thinkingTokensFor(level: ThinkingLevel | undefined): number {
  switch (level) {
    case 'low':
      return 4_000;
    case 'medium':
      return 12_000;
    case 'high':
      return 24_000;
    case 'max':
      return 63_999;
    default:
      return 0; // 'off' / undefined → no extended thinking
  }
}

/**
 * Parsed `orchestration/drain.config` — the watchdog/drainer's saved settings,
 * the single source of truth the watchdog reuses when it restarts the drainer.
 */
export interface DrainConfig {
  /** `ENABLED=1` → the watchdog auto-restarts the drainer; `0` → paused. */
  enabled: boolean;
  /**
   * `AUTO_RESTART=1` → patching a needs-restart setting (jobs/model/…) while a
   * drainer is running triggers a graceful restart automatically so the change
   * takes effect; `0`/absent → the change is saved but stays pending until the
   * next launch. A "live" key (it governs behavior immediately, not at launch).
   */
  autoRestart?: boolean;
  /** `JOBS` — max concurrent task-workers (instances). */
  jobs: number;
  /** `MODEL` — the default `claude -p --model` id for workers (per-task markers override). */
  model?: string;
  /** `STARTDIR` — the cwd the drainer starts in. */
  startDir?: string;
  /** `ADD_DIR` — the extra dir passed to `claude -p --add-dir`. */
  addDir?: string;
  /** `THINKING_LEVEL` — extended-thinking budget per run (optional knob). */
  thinkingLevel?: ThinkingLevel;
  /** `FAST_MODE` — whether `/fast` faster-output mode is requested (optional knob). */
  fastMode?: boolean;
  /**
   * `RESUME_AT` — a custom "don't start a new drain until this time" gate, as a
   * UNIX epoch in SECONDS. While set and in the future, the (armed) watchdog ticks
   * but stays idle; once now ≥ `resumeAt` the watchdog clears it and proceeds.
   * A watchdog-only scheduling knob (NOT a needs-restart drainer setting); cleared
   * automatically when `enabled` is turned off.
   */
  resumeAt?: number;
  /** Any keys we didn't recognize, preserved verbatim on round-trip. */
  extra: Record<string, string>;
}

/** A subset of `DrainConfig` fields the UI/CLI may patch. */
export interface DrainConfigPatch {
  enabled?: boolean;
  autoRestart?: boolean;
  jobs?: number;
  model?: string;
  startDir?: string;
  addDir?: string;
  thinkingLevel?: ThinkingLevel;
  fastMode?: boolean;
  /** Set a custom resume time (epoch seconds); `0` / a past time clears the gate. */
  resumeAt?: number;
}

/** How a drain.config setting takes effect — the single source of truth. */
export type DrainSettingClass =
  /** Read every tick / on each patch — no restart needed. */
  | 'live'
  /** Fixed at `claude -p` launch — needs a drainer restart to apply. */
  | 'needs-restart'
  /** Lives in the launchd plist (not drain.config) — needs a launchd reload. */
  | 'needs-launchd';

/**
 * Classify each tunable setting (keyed by its {@link DrainConfigPatch}/launchd
 * field name) by how it takes effect. The UI uses this to mark which saved
 * changes are still pending a restart, and the server uses it to decide whether
 * an auto-restart is warranted.
 */
export const DRAIN_SETTING_CLASS: Record<string, DrainSettingClass> = {
  enabled: 'live',
  autoRestart: 'live',
  jobs: 'needs-restart',
  model: 'needs-restart',
  thinkingLevel: 'needs-restart',
  fastMode: 'needs-restart',
  startDir: 'needs-restart',
  addDir: 'needs-restart',
  interval: 'needs-launchd',
};

/** The drain.config fields fixed at launch — a change to any needs a restart to apply. */
export const NEEDS_RESTART_FIELDS = ['jobs', 'model', 'thinkingLevel', 'fastMode', 'startDir', 'addDir'] as const;
export type NeedsRestartField = (typeof NEEDS_RESTART_FIELDS)[number];

/** One selectable worker model for the MODEL dropdown (id + human label). */
export interface DrainModelOption {
  id: string;
  label: string;
}

/**
 * The allowed worker model ids (the drain.config `MODEL` default + the dropdown).
 * Mirrors `queue-status.sh`'s `(model:)` resolution so the saved default and a
 * per-task marker resolve to the same canonical ids. Patches are validated
 * against this set.
 */
export const DRAIN_MODEL_OPTIONS: DrainModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 · 1M context' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
];

/** Just the allowed model ids (for validation). */
export const DRAIN_MODEL_IDS: string[] = DRAIN_MODEL_OPTIONS.map((m) => m.id);

/** The drainer's built-in default worker model (matches `drain-queue.sh`). */
export const DEFAULT_DRAIN_MODEL = 'claude-opus-4-8';

/**
 * What the RUNNING drainer launched with, parsed from `runs/active-run.json`
 * (written by `drain-queue.sh` at startup). Lets the UI diff the saved config
 * against the live process to show which needs-restart changes are pending.
 */
export interface ActiveRun {
  /** The drainer pid. */
  pid: number;
  /** The drainer's process group (for a force-kill of its whole tree). */
  pgid?: number;
  /** ISO start time of this run. */
  startISO?: string;
  /** Effective JOBS at launch. */
  jobs?: number;
  /** Effective MODEL at launch. */
  model?: string;
  /** Effective THINKING_LEVEL at launch (may be empty = off). */
  thinkingLevel?: string;
  /** Effective FAST_MODE at launch (raw string, may be empty). */
  fastMode?: string;
  /** Effective STARTDIR at launch. */
  startDir?: string;
  /** Effective ADD_DIR at launch. */
  addDir?: string;
}

/**
 * One needs-restart setting whose SAVED value differs from what the RUNNING
 * drainer launched with — i.e. a change that won't take effect until the drainer
 * is restarted. Surfaced as a "● pending — restart to apply" marker in the UI.
 */
export interface PendingChange {
  /** The config field key (camelCase, matches a {@link DrainConfig} field). */
  key: NeedsRestartField;
  /** Human label for the setting. */
  label: string;
  /** What the RUNNING drainer launched with (display string). */
  running: string;
  /** The saved drain.config value (display string). */
  saved: string;
}

/** The outcome of a drainer restart (graceful = finish-then-relaunch; force = kill-then-relaunch). */
export interface RestartResult {
  mode: 'graceful' | 'force';
  /** Whether the action completed without error. */
  ok: boolean;
  /** Whether a stop was initiated (graceful: `.drain-stop` written; force: pids/group signaled). */
  stopRequested: boolean;
  /** Whether a fresh drainer was started now (force) or will be by the supervisor (graceful). */
  willRestart: boolean;
  /** force: the drainer pid signaled. */
  pid?: number;
  /** force: the process group signaled (only when distinct from the server's + safe). */
  pgid?: number;
  /** force: worker pids signaled. */
  killed?: number[];
  /** force: the fresh drainer's pid (started synchronously). */
  startedPid?: number;
  /** graceful: the detached supervisor pid that waits for exit, then relaunches. */
  supervisorPid?: number;
  /** The launch command, when a (re)launch was attempted. */
  command?: string;
  /** A human note (e.g. why nothing was running). */
  message?: string;
  /** An error, when something failed. */
  error?: string;
}

/** The result of a drain.config patch (+ any auto-restart it triggered). */
export interface ConfigPatchResult {
  /** The new config after the patch. */
  config: DrainConfig;
  /** The config field names that actually changed (camelCase). */
  changed: string[];
  /** Set when this patch auto-triggered a graceful restart (AUTO_RESTART on + a needs-restart key changed + running). */
  autoRestart?: RestartResult;
}

/** One parsed line of `orchestration/watchdog.status` (the last-check summary). */
export interface WatchdogStatusLine {
  /** ISO timestamp of the check, when present. */
  at?: string;
  /** The human message after the timestamp. */
  message: string;
  /** Derived state from the message. */
  state: 'launching' | 'idle' | 'disabled' | 'leave' | 'paused' | 'unknown';
  /** Ready-task count the watchdog saw, when present. */
  ready?: number;
  /** Whether a runner was live at that check, when discoverable. */
  running?: boolean;
}

/** Parsed launchd plist for the watchdog agent (how often it ticks). */
export interface LaunchdInfo {
  /** The agent label (e.g. `com.curt.agent-drain-watchdog`). */
  label?: string;
  /** `StartInterval` in seconds (how often the watchdog runs). */
  intervalSeconds?: number;
  /** The program the agent runs (the watchdog script path). */
  program?: string;
  /** Whether the plist file exists on disk. */
  exists: boolean;
  /**
   * Whether the launchd agent is currently LOADED/bootstrapped (ticking on its
   * schedule) — from `launchctl list <label>`. `undefined` when we couldn't query
   * launchctl (e.g. tests / launchctl-less env). Distinct from {@link DrainConfig.enabled}:
   * `loaded` is whether launchd ticks at all; `enabled` is whether a tick launches a drain.
   */
  loaded?: boolean;
}

/**
 * The last watchdog tick the script recorded (start/end/duration + result),
 * parsed from `orchestration/watchdog.tick.json`. `watchdog.sh` stamps this every
 * tick so the dashboard can show last-run time + duration and the next scheduled
 * run; absent until the watchdog has ticked at least once with the stamping build.
 */
export interface WatchdogTick {
  /** ISO start time of the tick. */
  startedAt?: string;
  /** ISO end time of the tick (absent for a launching tick that exec'd the drainer). */
  finishedAt?: string;
  /** Wall-clock duration of the tick in milliseconds. */
  durationMs?: number;
  /** What the tick decided: `idle` | `launching` | `disabled` | `leave` | `paused` | a free string. */
  result?: string;
}

/** The outcome of a launchd-agent control action (load / unload / reload). */
export interface WatchdogAgentResult {
  /** Which action was requested. */
  action: 'start' | 'stop' | 'restart';
  /** Whether the agent ended up in the intended loaded state (true for start/restart, false for stop). */
  ok: boolean;
  /** The agent's loaded state after the action (from `launchctl list`), when discoverable. */
  loaded?: boolean;
  /** A human note (e.g. the resolved plist, or why it was a no-op). */
  message?: string;
  /** The launchctl error, when the action failed (the raw stderr, surfaced to the UI). */
  error?: string;
}

/** A live worker process (from a per-worker PID file the drainer writes). */
export interface WorkerProcess {
  /** Worker id (1-based, from the file name). */
  id: number;
  /** The OS pid. */
  pid: number;
  /** Whether the pid is alive right now. */
  alive: boolean;
  /** The run JSONL file this worker writes (bare name), when discoverable. */
  logFile?: string;
  /** ISO start time (the PID file's mtime). */
  startedAt?: string;
  /** Seconds the worker has been alive (server-computed at read time). */
  elapsedSeconds?: number;
  /**
   * Tasks this worker has finished THIS drain session — the count of result
   * objects already written to its run JSONL (the in-progress task isn't counted
   * until it completes). `undefined` when the log can't be read yet.
   */
  tasksCompleted?: number;
  /** Wall-clock duration (ms) of this worker's most recently completed task this session. */
  lastDurationMs?: number;
  /** Mean wall-clock duration (ms) across this worker's completed tasks this session (only those that reported one). */
  avgDurationMs?: number;
  /**
   * Best-effort ISO time the worker FINISHED its last task — the run-log file's
   * mtime. The drainer appends one result line per completed task, so the file's
   * last write ≈ the last task's finish; while a task is in flight nothing is
   * written, so this stays at the previous finish. Absent until the first task
   * completes.
   */
  lastFinishedAt?: string;
  /** Whether this worker's most recently completed task reported an error. */
  lastTaskErrored?: boolean;
  /** Count of this worker's completed tasks this session that reported an error. */
  errorCount?: number;
  /** Total cost (USD) across this worker's completed tasks this session, when the runs report it. */
  totalCostUsd?: number;
}

/** A claimed task currently being worked (derived from the board's `[~]` entries). */
export interface WorkerInstance {
  /** The task title. */
  title: string;
  /** The task body / detail text from TASKS.md (so the dashboard can show what's in progress). */
  body?: string;
  /** Repo the work targets, when discoverable from the title/meta. */
  repo?: string;
  /** Worktree slug the claim stamped. */
  worktree?: string;
  /**
   * Worker slot (1-based) running this task, when the worktree is a persistent
   * drain slot (`_drain-w<n>`). Lets the UI show "worker N" and link a task to a
   * worker process; `undefined` for a one-off (descriptive-slug) worktree.
   */
  worker?: number;
  /** ISO time the task was claimed. */
  startedAt?: string;
  /** Seconds since the task was claimed (server-computed at read time). */
  elapsedSeconds?: number;
  /** The TASKS.md line of the heading (for jump-to-edit). */
  line: number;
  /** Per-task model override from the `(model:)` heading marker, when present. */
  model?: string;
  /** Per-task thinking-level override from the `(think:)` heading marker, when present. */
  thinkingLevel?: string;
}

/** A problem / attention item surfaced to the dashboard. */
export interface Problem {
  kind: 'blocked' | 'worker-error' | 'watchdog-disabled' | 'stale-instance' | 'no-runner' | 'missing-workers';
  /** Short title. */
  title: string;
  /** Optional detail (a reason, an error excerpt). */
  detail?: string;
  /** Severity for tone. */
  severity: 'warn' | 'error';
}

/** One log/state file the dashboard can tail/open. */
export interface LogFileInfo {
  /** Stable key the client sends (never a path). */
  key: string;
  /** Display label. */
  label: string;
  /** Resolved absolute path. */
  path: string;
  /** Whether the file exists right now. */
  exists: boolean;
  /** Size in bytes (0 when absent). */
  size: number;
  /** ISO mtime, when it exists. */
  modified?: string;
}

/** A tail of one log file (the viewer's load shape). */
export interface LogTail extends LogFileInfo {
  /** The last N lines (chronological order). */
  lines: string[];
  /** Total line count in the file. */
  totalLines: number;
}

/** One relevant file location, with a category for grouping + an editor link. */
export interface FileLocation {
  /** Display label. */
  label: string;
  /** Resolved absolute path (the editor-link target). */
  path: string;
  /** Whether it exists right now. */
  exists: boolean;
  /** Grouping bucket. */
  category: 'config' | 'board' | 'logs' | 'script' | 'docs' | 'workspace';
}

/** A copy-pasteable shell command for manual control / observability. */
export interface WatchdogCommand {
  /** Stable id. */
  id: string;
  /** Short label. */
  label: string;
  /** What it does. */
  description: string;
  /** The shell command (with resolved real paths). */
  command: string;
  /** Grouping bucket. */
  category: 'observe' | 'control' | 'logs';
}

/** Per-status counts the watchdog header surfaces (a slim view of the board). */
export interface WatchdogCounts {
  ready: number;
  claimed: number;
  blocked: number;
  notReady: number;
  done: number;
}

/**
 * The whole watchdog snapshot (one GET) — deliberately fast (no run/history
 * parsing), so the control tab can poll it for live timers + status.
 */
export interface WatchdogSnapshot {
  /** Resolved agent-workspace notes dir. */
  notesDir: string;
  /** The `orchestration/` dir under it. */
  orchestrationDir: string;
  /** Parsed `drain.config` (safe defaults when the file is absent). */
  config: DrainConfig;
  /** Whether a drainer process is alive right now (lockfile PID check). */
  running: boolean;
  /** The drainer's pid, when running. */
  runnerPid?: number;
  /** What the RUNNING drainer launched with (from `runs/active-run.json`), when running. */
  activeRun?: ActiveRun;
  /**
   * Per-key diff of the saved `drain.config` against what the running drainer
   * launched with — needs-restart settings only. Empty when nothing is running
   * or every needs-restart setting matches. Drives the "● pending — restart to
   * apply" markers in the UI.
   */
  pending: PendingChange[];
  /** Live worker processes (from the drainer's per-worker PID files). */
  workers: WorkerProcess[];
  /** In-progress claimed tasks (from the board's `[~]` entries). */
  instances: WorkerInstance[];
  /** Per-status board counts. */
  counts: WatchdogCounts;
  /** Titles of the ready tasks (what's next up), in board order. */
  readyTitles: string[];
  /** The last watchdog check, when the status file exists. */
  status?: WatchdogStatusLine;
  /** Launchd agent info (interval / program / loaded). */
  launchd: LaunchdInfo;
  /** The last watchdog tick (start/end/duration/result) the script recorded, when present. */
  lastRun?: WatchdogTick;
  /**
   * Computed next watchdog tick (ISO), from the last tick + interval. Omitted when
   * the watchdog is disabled (ENABLED=0) or the launchd agent isn't loaded — then
   * the UI shows "—".
   */
  nextRunAt?: string;
  /**
   * The pending custom resume time (ISO), when a future `RESUME_AT` gate is set on
   * an armed watchdog — the watchdog stays idle until then. Drives the
   * "paused — resumes <time>" UI; omitted when no resume gate is pending.
   */
  resumeAt?: string;
  /** Problems / attention items. */
  problems: Problem[];
  /** Log/state files (for the tail UI). */
  logs: LogFileInfo[];
  /** Relevant file locations (editor links). */
  files: FileLocation[];
  /** Shell-command catalogue (real paths). */
  commands: WatchdogCommand[];
  /** Server's "now" (ISO) so the UI computes live elapsed against a consistent base. */
  now: string;
}

// ── The whole-page snapshot (one GET) ─────────────────────────────────────────

/** Everything the Orchestration page needs in one fetch. */
export interface OrchestrationOverview {
  /** Resolved workspace-notes directory the data was read from. */
  notesDir: string;
  /** Whether the notes directory exists. */
  notesDirExists: boolean;
  /** Parsed TASKS.md board (empty board when the file is missing). */
  board: WorkflowBoard;
  /** Parsed Tasks_Completed.md history, newest first. */
  history: HistoryEntry[];
  /** Live run status (latest entries + appending check). */
  runs: RunStatus;
  /** Aggregate stats over history + runs. */
  stats: OrchestrationStats;
}

// ── Orchestration Processing (per-category timing analytics) ──────────────────
// The Orchestration Processing page ingests the orchlog recorder's `timing-*.jsonl`
// into SQLite and renders per-category analytics over the stored rows. The math is
// cwip/orchestration's (`aggregateByCategory`/`summarize`) — the single source of
// truth; these are just the wire shapes the server returns and the page consumes.

/**
 * One per-category stat row, mirroring cwip/orchestration's `CategoryStat`
 * (re-declared here so the wire type is pure-data and the UI imports it via
 * `@shared` without pulling cwip into the bundle for a type alone).
 */
export interface CategoryStat {
  category: string;
  group: string;
  label: string;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  /** Arithmetic mean. */
  avgMs: number;
  medianMs: number;
  /** 95th percentile (linear-interpolated). */
  p95Ms: number;
}

/** Per-group total, mirroring cwip/orchestration's `GroupRollup`. */
export interface GroupRollup {
  group: string;
  totalMs: number;
  count: number;
}

/** High-level rollup across the filtered events, mirroring cwip's `TimingSummary`. */
export interface TimingSummary {
  /** Distinct tasks (sessions with a kind:'task' summary row, else distinct sessions). */
  taskCount: number;
  eventCount: number;
  totalMs: number;
  byGroup: GroupRollup[];
  firstTs: number | null;
  lastTs: number | null;
}

/** One bucket of the duration-over-time trend (epoch-ms bucket start + totals). */
export interface TimingTrendPoint {
  /** Bucket start (epoch ms) — the chart x value. */
  ts: number;
  /** Summed work duration (ms) of events whose `ts` falls in this bucket. */
  totalMs: number;
  /** Event count in this bucket. */
  count: number;
}

/** A source `timing-*.jsonl` file the stored rows came from. */
export interface TimingSource {
  /** Absolute path of the source file (editor-link target). */
  file: string;
  /** Rows ingested from it. */
  count: number;
}

/** One stored timing row, surfaced to the page's table/source views. */
export interface TimingRow {
  eventId: string;
  session: string;
  worker: string;
  taskId: string;
  taskTitle: string;
  repo: string;
  category: string;
  group: string;
  label: string;
  kind: string;
  command?: string;
  exitCode?: number;
  ok: boolean;
  note?: string;
  start: string;
  end: string;
  durationMs: number;
  ts: number;
  sourceFile?: string;
}

/** The whole Orchestration Processing snapshot (one GET), already aggregated. */
export interface TimingOverview {
  /** Resolved agent-workspace notes dir the JSONL is read from. */
  notesDir: string;
  /** The `orchestration/runs/` dir under it (where `timing-*.jsonl` live). */
  runsDir: string;
  /** Per-category stats (cwip `aggregateByCategory`), sorted by total time desc. */
  stats: CategoryStat[];
  /** High-level rollup (cwip `summarize`). */
  summary: TimingSummary;
  /** Duration trend over time, bucketed. */
  trend: TimingTrendPoint[];
  /** The filtered rows (recent first), for the table view. */
  rows: TimingRow[];
  /** Source files the stored rows came from. */
  sources: TimingSource[];
  /** Distinct repos present in the store (for the repo filter). */
  repos: string[];
  /** Total stored rows matching the filter (rows[] may be capped for display). */
  total: number;
}

/** Result of a sync-from-files ingest. */
export interface TimingIngestResult {
  filesRead: number;
  inserted: number;
  skipped: number;
}

/** Client-side query params for the timings GET (epoch-ms bounds + canonical repo). */
export interface TimingQueryParams {
  /** Inclusive lower bound on `ts` (epoch ms). */
  from?: number;
  /** Inclusive upper bound on `ts` (epoch ms). */
  to?: number;
  /** Canonical repo, or `all`/omit for every repo. */
  repo?: string;
}

/**
 * Bucket events' work duration over time into evenly-spaced points for the trend
 * chart. Pure: takes `{ ts, durationMs }` items (kind:'task' summary rows should be
 * excluded by the caller, like the aggregators do) and a target bucket count, and
 * returns chronological buckets spanning first→last ts. Empty input → []; a single
 * timestamp → one bucket. `bucketMs` is derived from the span so the chart always
 * shows ~`targetBuckets` points regardless of range (minute-level to multi-day).
 */
export function bucketTimingTrend(items: { ts: number; durationMs: number }[], targetBuckets = 48): TimingTrendPoint[] {
  const points = items.filter((i) => Number.isFinite(i.ts) && i.ts > 0);
  if (points.length === 0) return [];
  let min = points[0].ts;
  let max = points[0].ts;
  for (const p of points) {
    if (p.ts < min) min = p.ts;
    if (p.ts > max) max = p.ts;
  }
  const span = max - min;
  if (span <= 0) {
    const totalMs = points.reduce((s, p) => s + p.durationMs, 0);
    return [{ ts: min, totalMs, count: points.length }];
  }
  const bucketMs = Math.max(1, Math.ceil(span / Math.max(1, targetBuckets)));
  const buckets = new Map<number, { totalMs: number; count: number }>();
  for (const p of points) {
    const key = min + Math.floor((p.ts - min) / bucketMs) * bucketMs;
    const b = buckets.get(key);
    if (b) {
      b.totalMs += p.durationMs;
      b.count += 1;
    } else {
      buckets.set(key, { totalMs: p.durationMs, count: 1 });
    }
  }
  return [...buckets.entries()]
    .map(([ts, v]) => ({ ts, totalMs: v.totalMs, count: v.count }))
    .sort((a, b) => a.ts - b.ts);
}

// ── Display formatters (pure, browser-safe — shared by the UI + lib) ──────────

/** Format a seconds count as a compact `Hh Mm Ss` / `Mm Ss` / `Ns` string. */
export function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !h) parts.push(`${s}s`);
  return parts.join(' ') || `${s}s`;
}

/** Format a token count compactly (`1.2k`, `3.4M`). */
export function formatTokens(n: number | undefined): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Format a USD cost (`$0.0042`, `$12.30`). */
export function formatUsd(n: number | undefined): string {
  if (!n) return '$0.00';
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
