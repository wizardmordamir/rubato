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
  /** Referenceable id from an `(id:X)` marker (so a follow-up can depend on it). */
  id?: string;
  /** Dependency ids from a `(needs:X,Y)` marker — blocked while any still exists. */
  needs?: string[];
  /** Batch group from a `(group:G)` marker — done together by one worker. */
  group?: string;
  /** Recurrence cadence N from a `(recur:N)` marker (standing task). */
  recur?: number;
  /** Last-run stamp M from a `(recur:N last:M)` marker (drainer-maintained). */
  recurLast?: number;
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
 * One model-tier in a fleet configuration — a dedicated pool of workers that claims
 * tasks matching its model alias and applies its own thinking cap.
 */
export interface FleetTier {
  /**
   * Short model alias matching `queue-status.sh`'s `resolve_model()`:
   * `'opus'` | `'opus-1m'` | `'sonnet'` | `'haiku'` | `'fable'`.
   */
  modelAlias: string;
  /** Concurrent workers for this tier (1–8). */
  slots: number;
  /** Maximum thinking-level cap — tasks asking for more are clamped here. */
  thinkingLevel: ThinkingLevel;
  /** Request `/fast` mode for this tier's workers. */
  fastMode: boolean;
}

/** A fleet model option — alias, full model id, and human label. */
export interface FleetModelOption {
  /** Short alias used in drain.config / `queue-status.sh`. */
  alias: string;
  /** Full Claude model id (e.g. `claude-sonnet-4-6`). */
  id: string;
  /** Human-readable label for UI dropdowns. */
  label: string;
}

/** Available models for fleet tier configuration (alias ↔ id ↔ label). */
export const FLEET_MODEL_OPTIONS: FleetModelOption[] = [
  { alias: 'opus', id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { alias: 'opus-1m', id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 · 1M' },
  { alias: 'sonnet', id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { alias: 'haiku', id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { alias: 'fable', id: 'claude-fable-5', label: 'Fable 5' },
];

/**
 * Serialize fleet tiers to a pipe-separated string for the `active-run.json`
 * comparison — `alias,slots,thinking,fast` per tier, joined by `|`.
 */
export function serializeFleetTiers(tiers: FleetTier[]): string {
  return tiers.map((t) => `${t.modelAlias},${t.slots},${t.thinkingLevel},${t.fastMode ? 1 : 0}`).join('|');
}

/**
 * A named, reusable fleet configuration — e.g. "Strong" (Opus-heavy), "Fast"
 * (Sonnet/Haiku), "Slow & cheap". Saved alongside `drain.config` so you can swap
 * the whole worker mix in one click. Applying a preset writes its {@link FleetTier}s
 * into `drain.config` (fleet mode) exactly as the per-tier editor would.
 */
export interface FleetPreset {
  /** Stable id — a slug of {@link name}; saving the same name overwrites the preset. */
  id: string;
  /** Human label shown in the UI ("Strong", "Fast", "Slow"). */
  name: string;
  /** The worker pools this preset applies when loaded. */
  tiers: FleetTier[];
  /** Optional one-line description (when/why to use this fleet). */
  note?: string;
  /** Epoch ms of the last save (for ordering / display). */
  updatedAt?: number;
}

/** The client → server payload to create or overwrite a {@link FleetPreset}. */
export interface SaveFleetPreset {
  name: string;
  tiers: FleetTier[];
  note?: string;
}

/** Result of applying a named fleet preset — the config-patch outcome plus which preset ran. */
export interface ApplyFleetPresetResult extends ConfigPatchResult {
  /** The preset that was loaded into `drain.config`. */
  preset: FleetPreset;
}

/** Derive a {@link FleetPreset} id (stable key) from a display name. */
export function fleetPresetId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'fleet';
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
   * `AUTO_TIER` — when on, the fleet auto-grows to cover any unblocked task no
   * current tier can claim: adding 1 slot of the needed model (at the task's
   * thinking level). Lets you queue any difficulty and trust something will take it.
   */
  autoTier?: boolean;
  /**
   * `RESUME_AT` — a custom "don't start a new drain until this time" gate, as a
   * UNIX epoch in SECONDS. While set and in the future, the (armed) watchdog ticks
   * but stays idle; once now ≥ `resumeAt` the watchdog clears it and proceeds.
   * A watchdog-only scheduling knob (NOT a needs-restart drainer setting); cleared
   * automatically when `enabled` is turned off.
   */
  resumeAt?: number;
  /**
   * `FLEET_TIERS` + `FLEET_N` — per-model worker tiers for fleet mode.
   * When set, replaces the flat `jobs`/`model`/`thinkingLevel`/`fastMode` with
   * dedicated pools. Each tier spawns `slots` workers that only claim tasks
   * matching their `modelAlias` (or untagged tasks), applying the tier's thinking cap.
   * `jobs` is kept in sync as the sum of all tier slots.
   */
  fleetTiers?: FleetTier[];
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
  /** Toggle AUTO_TIER (auto-grow the fleet to cover otherwise-unservable tasks). */
  autoTier?: boolean;
  /** Set a custom resume time (epoch seconds); `0` / a past time clears the gate. */
  resumeAt?: number;
  /** Set fleet tiers (fleet mode); `null` or `[]` clears fleet mode (reverts to flat). */
  fleetTiers?: FleetTier[] | null;
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
  fleetTiers: 'needs-restart',
  interval: 'needs-launchd',
};

/** The drain.config fields fixed at launch — a change to any needs a restart to apply. */
export const NEEDS_RESTART_FIELDS = [
  'jobs',
  'model',
  'thinkingLevel',
  'fastMode',
  'startDir',
  'addDir',
  'fleetTiers',
] as const;
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

// ── Task builder (compose/edit a TASKS.md entry) ──────────────────────────────
//
// The Orchestration "Tasks" tab lets you author a queue entry through a form
// instead of hand-editing markdown — so the `(markers)` syntax from
// TASKS.GUIDE.md is always well-formed. These browser-safe helpers (no I/O)
// validate a draft and serialize it to the canonical `## [tag] (markers) Title`
// block; the server applies the block to TASKS.md under a lock (see
// `src/server/orchestration.ts`), and the pure file transforms live in
// `src/lib/orchestration/editTasks.ts`.

/**
 * Statuses the builder can author. The runtime-only tags (`[~]` claimed, `[x]`
 * done) are never set by hand — the drainer owns them — so the form is limited
 * to the three you actually queue with:
 *   - `ready`     → `[ ]` claimable
 *   - `hold`      → `[b]` your manual hold switch (won't start until flipped)
 *   - `not-ready` → `[-]` blocked on something external
 */
export type TaskDraftStatus = 'ready' | 'hold' | 'not-ready';

export const TASK_DRAFT_STATUSES: TaskDraftStatus[] = ['ready', 'hold', 'not-ready'];

export const TASK_DRAFT_STATUS_LABELS: Record<TaskDraftStatus, string> = {
  ready: 'Ready',
  hold: 'Hold (blocked by you)',
  'not-ready': 'Not ready (external dep)',
};

/** The `[tag]` char written for each draft status. */
export const TASK_DRAFT_STATUS_TAG: Record<TaskDraftStatus, string> = {
  ready: ' ',
  hold: 'b',
  'not-ready': '-',
};

/** The short model aliases a `(model:X)` marker accepts (per TASKS.GUIDE.md). */
export const TASK_MODEL_ALIASES: string[] = FLEET_MODEL_OPTIONS.map((m) => m.alias);

/** A valid id/group slug — `[A-Za-z0-9._-]` (TASKS.GUIDE.md). */
export const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * A composable task entry. Every field except `status` + `title` is optional and
 * maps to a heading marker; empties are simply omitted from the serialized line.
 */
export interface TaskDraft {
  status: TaskDraftStatus;
  /** The task title (one line, no newlines, no `]`-leading weirdness). */
  title: string;
  /** Free-form detail lines beneath the heading (kept verbatim). */
  body?: string;
  /** `(model:X)` — a short alias from {@link TASK_MODEL_ALIASES}. */
  model?: string;
  /** `(think:Y)` — a {@link ThinkingLevel}. */
  thinkingLevel?: ThinkingLevel;
  /** `(id:X)` — referenceable id for dependents. */
  id?: string;
  /** `(needs:X,Y)` — ids this task is blocked on. */
  needs?: string[];
  /** `(group:G)` — batch-with-one-worker group. */
  group?: string;
  /** `(recur:N)` — recurrence cadence (standing task). */
  recur?: number;
  /** `last:M` inside the recur marker — preserved verbatim on edit. */
  recurLast?: number;
}

/** Where a new task is inserted relative to the existing board. */
export interface TaskInsertPosition {
  at: 'top' | 'bottom' | 'before' | 'after';
  /** For `before`/`after`: the verbatim `rawHeading` of the anchor task. */
  anchorHeading?: string;
}

/**
 * Derive a one-line title from the body's detail text — the first non-empty
 * line, clipped to its first sentence when that line is a long run-on (e.g. a
 * pasted paragraph) so the heading stays a sensible single line. Returns `''`
 * when there's no usable text. Lets a quick paste-and-add flow skip the title.
 */
export function deriveTaskTitle(body: string | undefined): string {
  const firstLine =
    (body ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  if (!firstLine) return '';
  // Clip a run-on first line to its first sentence (terminator + following
  // space, or end-of-line). Short lines with no terminator pass through whole.
  const sentence = firstLine.match(/^.*?[.!?](?=\s|$)/)?.[0];
  return (sentence ?? firstLine).trim();
}

/**
 * The title that will actually be written for a draft: the explicit title if
 * the user typed one, otherwise {@link deriveTaskTitle} of the body. Single
 * source of truth shared by validation, serialization, and the UI preview.
 */
export function effectiveTaskTitle(draft: TaskDraft): string {
  const explicit = (draft.title ?? '').trim();
  return explicit || deriveTaskTitle(draft.body);
}

/**
 * Validate a draft against the TASKS.GUIDE.md rules. Returns a list of
 * human-readable errors ( empty ⇒ valid ). Used both for live form feedback in
 * the UI and as the server's authoritative gate before writing.
 */
export function validateTaskDraft(draft: TaskDraft): string[] {
  const errs: string[] = [];
  if (!TASK_DRAFT_STATUSES.includes(draft.status)) errs.push(`invalid status: ${draft.status}`);

  // The title may be left blank and derived from the first line of the details.
  const title = effectiveTaskTitle(draft);
  if (!title) errs.push('add a title or some detail lines to derive one from');
  if (/[\r\n]/.test(draft.title ?? '')) errs.push('title must be a single line');

  if (draft.model != null && draft.model !== '' && !TASK_MODEL_ALIASES.includes(draft.model)) {
    errs.push(`unknown model alias "${draft.model}" (use ${TASK_MODEL_ALIASES.join(', ')})`);
  }
  if (
    draft.thinkingLevel != null &&
    (draft.thinkingLevel as string) !== '' &&
    !THINKING_LEVELS.includes(draft.thinkingLevel)
  ) {
    errs.push(`unknown thinking level "${draft.thinkingLevel}" (use ${THINKING_LEVELS.join(', ')})`);
  }

  if (draft.id != null && draft.id !== '' && !TASK_ID_PATTERN.test(draft.id)) {
    errs.push(`id "${draft.id}" must match [A-Za-z0-9._-]`);
  }
  if (draft.group != null && draft.group !== '' && !TASK_ID_PATTERN.test(draft.group)) {
    errs.push(`group "${draft.group}" must match [A-Za-z0-9._-]`);
  }
  for (const n of draft.needs ?? []) {
    if (!TASK_ID_PATTERN.test(n)) errs.push(`needs id "${n}" must match [A-Za-z0-9._-]`);
  }
  if (draft.id && (draft.needs ?? []).includes(draft.id)) errs.push('a task cannot depend on its own id');

  if (draft.recur != null) {
    if (!Number.isInteger(draft.recur) || draft.recur < 1) errs.push('recur cadence must be a positive integer');
  }
  if (draft.recurLast != null && (!Number.isInteger(draft.recurLast) || draft.recurLast < 0)) {
    errs.push('recur last stamp must be a non-negative integer');
  }

  return errs;
}

/**
 * Serialize the heading marker group(s) for a draft, in canonical order:
 * `(recur:N last:M) (id:X) (needs:X,Y) (group:G) (model:X) (think:Y)`. Returns
 * a single space-joined string of `(...)` groups, or `''` when none apply.
 */
export function serializeTaskMarkers(draft: TaskDraft): string {
  const groups: string[] = [];
  if (draft.recur != null) {
    groups.push(draft.recurLast != null ? `(recur:${draft.recur} last:${draft.recurLast})` : `(recur:${draft.recur})`);
  }
  if (draft.id) groups.push(`(id:${draft.id})`);
  if (draft.needs?.length) groups.push(`(needs:${draft.needs.join(',')})`);
  if (draft.group) groups.push(`(group:${draft.group})`);
  if (draft.model) groups.push(`(model:${draft.model})`);
  if (draft.thinkingLevel) groups.push(`(think:${draft.thinkingLevel})`);
  return groups.join(' ');
}

/**
 * Serialize a draft to its full markdown block: the `## [tag] (markers) Title`
 * heading plus any body lines beneath. No trailing newline (the file writer
 * owns inter-task spacing). Throws if the draft is invalid — call
 * {@link validateTaskDraft} first for friendly errors.
 */
export function serializeTaskBlock(draft: TaskDraft): string {
  const errs = validateTaskDraft(draft);
  if (errs.length) throw new Error(`invalid task draft: ${errs.join('; ')}`);
  const tag = TASK_DRAFT_STATUS_TAG[draft.status];
  const markers = serializeTaskMarkers(draft);
  const heading = `## [${tag}]${markers ? ` ${markers}` : ''} ${effectiveTaskTitle(draft)}`;
  const body = (draft.body ?? '').replace(/\s+$/, '');
  return body ? `${heading}\n${body}` : heading;
}

/**
 * Seed a builder draft from a parsed task — for the Edit form. Maps the heading
 * status back to a {@link TaskDraftStatus} (claimed/done aren't editable here)
 * and copies the round-trippable markers from {@link WorkflowTaskMeta}.
 */
export function draftFromTask(task: WorkflowTask): TaskDraft {
  const tag = task.rawHeading.match(/^##\s+\[(.)\]/)?.[1] ?? ' ';
  const status: TaskDraftStatus =
    tag === '-' ? 'not-ready' : tag === 'b' || tag === 'B' || tag === '!' ? 'hold' : 'ready';
  const m = task.meta;
  return {
    status,
    title: task.title,
    body: task.body || undefined,
    model: m.model && TASK_MODEL_ALIASES.includes(m.model) ? m.model : undefined,
    thinkingLevel:
      m.thinkingLevel && THINKING_LEVELS.includes(m.thinkingLevel as ThinkingLevel)
        ? (m.thinkingLevel as ThinkingLevel)
        : undefined,
    id: m.id,
    needs: m.needs,
    group: m.group,
    recur: m.recur,
    recurLast: m.recurLast,
  };
}

/** Is a parsed task one the builder can edit (not a running/finished entry)? */
export function isTaskEditable(task: WorkflowTask): boolean {
  if (task.status === 'claimed' || task.status === 'done') return false;
  // A resume/worktree stamp means the watchdog is actively shepherding it.
  if (task.meta.worktree || task.meta.resume) return false;
  return true;
}

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
  /**
   * Serialized fleet tiers at launch — pipe-separated `alias,slots,think,fast` per tier
   * (see `serializeFleetTiers`). Present only when fleet mode was active at launch.
   */
  fleetConfig?: string;
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

/** A one-click remediation the dashboard can offer for a {@link Problem}. */
export interface ProblemFix {
  /** Which action resolves it (maps to a watchdog endpoint / config change). */
  action: 'wake' | 'enable' | 'start' | 'restart' | 'add-tier' | 'none';
  /** Button label, e.g. "Wake workers". */
  label: string;
  /**
   * True when the system ALREADY self-heals this (the watchdog relaunches, the
   * drainer auto-restarts) — render as an informational "auto-fixing" note rather
   * than a manual button.
   */
  auto?: boolean;
}

/**
 * A problem / attention item surfaced to the dashboard. Beyond the raw `detail`
 * paragraph, it carries a friendly `category`, scannable `fields`, and an optional
 * one-click `fix` so the UI can show structured values (not prose) and self-heal.
 */
export interface Problem {
  kind:
    | 'blocked'
    | 'worker-error'
    | 'watchdog-disabled'
    | 'stale-instance'
    | 'no-runner'
    | 'missing-workers'
    | 'unservable-tasks';
  /** Short title. */
  title: string;
  /** Optional detail (a reason, an error excerpt) — shown only when expanded. */
  detail?: string;
  /** Severity for tone. */
  severity: 'warn' | 'error';
  /** Friendly one-word category for the chip ("Capacity", "Blocked", "Coverage", "Worker"). */
  category?: string;
  /** Structured key/value fields for at-a-glance scanning (no paragraph reading). */
  fields?: { label: string; value: string }[];
  /** A suggested/auto remediation, when one exists. */
  fix?: ProblemFix;
}

/** Per-configured-slot worker status — drives the color-coded Worker rows. */
export type WorkerSlotStatus =
  /** Alive worker actively on a claimed task. */
  | 'working'
  /** Alive worker with no task right now (between tasks / nothing for its model). */
  | 'waiting'
  /** Drainer running but this slot has no live process (exited / short-handed). */
  | 'missing'
  /** Drainer not running — nothing to run. */
  | 'stopped';

/**
 * One CONFIGURED worker slot — always rendered (3 configured → 3 rows), so a
 * short-handed drainer is visually obvious. Combines the slot's intended
 * model/thinking with the live process + claimed task backing it (if any).
 */
export interface FleetSlot {
  /** 1-based slot id (sequential across tiers). Matches {@link WorkerProcess.id}. */
  id: number;
  /** Model alias for this slot ('opus' | 'sonnet' | …). */
  modelAlias: string;
  /** Human model label ("Opus 4.8"). */
  modelLabel: string;
  /** Thinking cap for this slot. */
  thinkingLevel: ThinkingLevel;
  /** Whether /fast is requested for this slot. */
  fastMode: boolean;
  /** 0-based fleet tier this slot belongs to (0 in flat mode). */
  tier: number;
  /** Derived status. */
  status: WorkerSlotStatus;
  /** A short, scannable reason for the status ("No task for this model"). */
  reason: string;
  /** OS pid of the live worker process backing this slot, when alive. */
  pid?: number;
  /** The drainer (parent) pid this slot runs under, when running. */
  drainPid?: number;
  /** The task title this slot is working, when on a task. */
  task?: string;
  /** TASKS.md line of the current task (jump-to-edit). */
  taskLine?: number;
  /** ISO start of the current task (when working). */
  startedAt?: string;
  /** Seconds elapsed on the current task (server-computed; client refines against `now`). */
  elapsedSeconds?: number;
  /** ISO the slot's last task finished (between tasks). */
  endedAt?: string;
  /** Tasks this slot completed this drain session. */
  tasksCompleted?: number;
  /** Whether the slot's most recent task errored (an error tint, even while waiting). */
  lastErrored?: boolean;
}

/** A ready (unblocked) task as the snapshot exposes it — enough to judge fleet coverage. */
export interface ReadyTask {
  title: string;
  /** TASKS.md heading line. */
  line: number;
  /** Per-task `(model:X)` marker (alias), when present. */
  model?: string;
  /** Per-task `(think:Y)` marker, when present. */
  thinkingLevel?: string;
}

/** Outcome of growing the fleet to cover otherwise-unservable tasks (the reconcile action). */
export interface ReconcileFleetResult {
  /** The tiers added (one 1-slot tier per missing model); empty when nothing to do. */
  added: FleetTier[];
  /** The model aliases that were covered. */
  models: string[];
  /** The resulting config. */
  config: DrainConfig;
  /** A graceful restart that fired so the new tier takes effect now (when a drainer was live). */
  restarted?: RestartResult;
}

/** Fleet-coverage summary: which unblocked tasks no current tier can ever claim. */
export interface UnservableSummary {
  /** Ready tasks whose `(model:X)` matches no tier in the fleet (model-match rule). */
  tasks: ReadyTask[];
  /** Total count (== tasks.length; convenience for headers). */
  count: number;
  /** The distinct model aliases that would need a tier to clear the backlog. */
  neededModels: string[];
  /** Whether AUTO_TIER is on (the fleet auto-grows to cover unservable tasks). */
  autoTier: boolean;
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
  /**
   * One row PER CONFIGURED SLOT (3 configured → 3 rows), each combining its
   * intended model/thinking with the live process + claimed task backing it — so a
   * short-handed drainer ("3 configured, 1 live") is visually obvious.
   */
  slots: FleetSlot[];
  /** In-progress claimed tasks (from the board's `[~]` entries). */
  instances: WorkerInstance[];
  /** Per-status board counts. */
  counts: WatchdogCounts;
  /** Titles of the ready tasks (what's next up), in board order. */
  readyTitles: string[];
  /** Ready (unblocked) tasks with their per-task model/thinking markers, in board order. */
  readyTasks: ReadyTask[];
  /** Fleet-coverage summary — unblocked tasks no current tier can ever claim. */
  unservable: UnservableSummary;
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

// ── Claude usage / rate-limits ────────────────────────────────────────────────

/**
 * Current per-minute rate-limit snapshot from the Anthropic API headers,
 * returned by `GET /api/orchestration/claude-usage`.
 */
export interface ClaudeRateLimitInfo {
  /** Whether `ANTHROPIC_API_KEY` was present; false means no live data. */
  hasApiKey: boolean;
  /** ISO timestamp of when this snapshot was captured. */
  fetchedAt: string;
  /** Per-minute token limit for this API key tier (null when unavailable). */
  limitTokensPerMinute: number | null;
  /** Tokens remaining in the current per-minute window. */
  remainingTokensPerMinute: number | null;
  /** ISO timestamp when the per-minute token limit resets. */
  resetTokensAt: string | null;
  /** Per-minute request limit for this API key tier. */
  limitRequestsPerMinute: number | null;
  /** Requests remaining in the current per-minute window. */
  remainingRequestsPerMinute: number | null;
  /** ISO timestamp when the per-minute request limit resets. */
  resetRequestsAt: string | null;
  /** Error message if the probe call failed. */
  error?: string;
}
