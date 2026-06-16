/**
 * Pure parsers + derivations for the watchdog / drain-control surface (the area
 * that starts, stops, paces, and observes the headless `claude -p` queue drainer
 * and its launchd watchdog).
 *
 * Everything here is pure (string/data in, model out — no fs/process/server
 * imports), so it lives in the library layer next to the board/history/runs
 * parsers and is unit-tested directly. The file reads, process checks, and the
 * launchctl/spawn side-effects that feed these live in `src/server/watchdog.ts`.
 *
 * The control files this understands (all under the agent-workspace dir):
 *   - `orchestration/drain.config`  — `KEY=value` shell assignments (the drainer's
 *     saved settings: ENABLED/JOBS/STARTDIR/ADD_DIR + the new THINKING_LEVEL/FAST_MODE).
 *   - `orchestration/watchdog.status` — one line: `<ISO>  <message>`.
 *   - the launchd plist — `StartInterval` is the watchdog's tick interval.
 */

import type {
  ActiveRun,
  DrainConfig,
  DrainConfigPatch,
  FleetPreset,
  FleetSlot,
  FleetTier,
  LaunchdInfo,
  NeedsRestartField,
  PendingChange,
  Problem,
  ReadyTask,
  ThinkingLevel,
  UnservableSummary,
  WatchdogCommand,
  WatchdogStatusLine,
  WatchdogTick,
  WorkerInstance,
  WorkerProcess,
  WorkflowBoard,
} from '../../shared/orchestration';
import {
  FLEET_MODEL_OPTIONS,
  fleetPresetId,
  NEEDS_RESTART_FIELDS,
  serializeFleetTiers,
  THINKING_LEVELS,
} from '../../shared/orchestration';

/**
 * Validate + clamp an arbitrary list of fleet tiers into well-formed {@link FleetTier}s:
 * drop tiers with an unknown model alias, clamp slots to 1–8, coerce the thinking level
 * to a known value, and normalize `fastMode` to a boolean. The single source of truth for
 * what a valid tier is — shared by {@link applyDrainPatch} and the fleet-preset store.
 */
export function sanitizeFleetTiers(tiers: readonly FleetTier[]): FleetTier[] {
  const validAliases = new Set(FLEET_MODEL_OPTIONS.map((m) => m.alias));
  return tiers
    .filter((t) => t?.modelAlias && validAliases.has(t.modelAlias))
    .map((t) => ({
      modelAlias: t.modelAlias,
      slots: Math.max(1, Math.min(8, Math.floor(t.slots) || 1)),
      thinkingLevel: (THINKING_LEVELS as string[]).includes(t.thinkingLevel)
        ? t.thinkingLevel
        : ('off' as ThinkingLevel),
      fastMode: Boolean(t.fastMode),
    }));
}

// ── drain.config (KEY=value shell assignments) ────────────────────────────────

/** The drainer's built-in defaults (matches `drain-queue.sh`'s own fallbacks). */
export function defaultDrainConfig(): DrainConfig {
  // `autoRestart` is a core toggle (like `enabled`): always present, default off,
  // so it always round-trips through serialize↔parse and shows in drain.config.
  return { enabled: false, autoRestart: false, jobs: 1, extra: {} };
}

/** Recognized config keys (everything else round-trips through `extra`). */
const KNOWN_KEYS = new Set([
  'ENABLED',
  'AUTO_RESTART',
  'JOBS',
  'MODEL',
  'STARTDIR',
  'ADD_DIR',
  'THINKING_LEVEL',
  'FAST_MODE',
  'AUTO_TIER',
  'RESUME_AT',
]);

/** Strip one layer of matching surrounding single/double quotes from a value. */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Truthy shell-ish value (`1`/`true`/`yes`/`on`, case-insensitive). */
function truthy(v: string): boolean {
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Coerce an arbitrary string to a valid {@link ThinkingLevel}, or `undefined`. */
function asThinkingLevel(v: string): ThinkingLevel | undefined {
  const t = v.trim().toLowerCase();
  return (THINKING_LEVELS as string[]).includes(t) ? (t as ThinkingLevel) : undefined;
}

/**
 * Parse `drain.config` text into a {@link DrainConfig}. Tolerant: blank lines and
 * `#` comments are skipped, values may be quoted, and unknown keys are preserved
 * verbatim under `extra` so a round-trip never drops a hand-added setting.
 */
export function parseDrainConfig(text: string): DrainConfig {
  const cfg = defaultDrainConfig();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1));
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    switch (key) {
      case 'ENABLED':
        cfg.enabled = truthy(value);
        break;
      case 'AUTO_RESTART':
        cfg.autoRestart = truthy(value);
        break;
      case 'JOBS': {
        const n = Number.parseInt(value, 10);
        cfg.jobs = Number.isFinite(n) && n > 0 ? n : 1;
        break;
      }
      case 'MODEL':
        if (value) cfg.model = value;
        break;
      case 'STARTDIR':
        if (value) cfg.startDir = value;
        break;
      case 'ADD_DIR':
        if (value) cfg.addDir = value;
        break;
      case 'THINKING_LEVEL': {
        const lvl = asThinkingLevel(value);
        if (lvl) cfg.thinkingLevel = lvl;
        break;
      }
      case 'FAST_MODE':
        cfg.fastMode = truthy(value);
        break;
      case 'AUTO_TIER':
        cfg.autoTier = truthy(value);
        break;
      case 'RESUME_AT': {
        // A UNIX epoch in SECONDS; only a positive integer is a real gate.
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) cfg.resumeAt = n;
        break;
      }
      default:
        if (!KNOWN_KEYS.has(key)) cfg.extra[key] = value;
    }
  }
  // Post-process: reconstruct fleetTiers from FLEET_TIERS + FLEET_N keys in extra.
  const fleetCountRaw = cfg.extra.FLEET_TIERS;
  if (fleetCountRaw) {
    const count = Number.parseInt(fleetCountRaw, 10);
    if (Number.isFinite(count) && count > 0) {
      const validAliases = new Set(FLEET_MODEL_OPTIONS.map((m) => m.alias));
      const tiers: FleetTier[] = [];
      for (let i = 0; i < Math.min(count, 16); i++) {
        const raw = cfg.extra[`FLEET_${i}`];
        if (!raw) continue;
        const [aliasRaw, slotsRaw, thinkRaw, fastRaw] = raw.split(',');
        const alias = aliasRaw?.trim() ?? '';
        if (!alias || !validAliases.has(alias)) continue;
        const slots = Math.max(1, Math.min(8, Number.parseInt(slotsRaw ?? '1', 10) || 1));
        const thinkingLevel = asThinkingLevel(thinkRaw ?? '') ?? 'off';
        const fastMode = truthy(fastRaw ?? '0');
        tiers.push({ modelAlias: alias, slots, thinkingLevel, fastMode });
      }
      if (tiers.length > 0) {
        cfg.fleetTiers = tiers;
        cfg.jobs = tiers.reduce((s, t) => s + t.slots, 0);
        delete cfg.extra.FLEET_TIERS;
        for (let i = 0; i < count; i++) delete cfg.extra[`FLEET_${i}`];
      }
    }
  }
  return cfg;
}

/** Shell-quote a value for `drain.config` (double quotes; escape embedded `"`/`\`). */
function shq(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Serialize a {@link DrainConfig} back to `drain.config` text. The format stays
 * `KEY=value` so `watchdog.sh`/`drain-queue.sh`'s `. "$CONFIG"` sourcing still
 * works. Optional knobs are emitted only when set, so a config never grows noise.
 */
export function serializeDrainConfig(cfg: DrainConfig): string {
  const lines: string[] = [
    '# managed by rubato watchdog control — set ENABLED=0 (or run `watchdog pause`) to stop auto-restart',
    `ENABLED=${cfg.enabled ? 1 : 0}`,
    `AUTO_RESTART=${cfg.autoRestart ? 1 : 0}`,
    `JOBS=${cfg.jobs}`,
  ];
  if (cfg.model) lines.push(`MODEL=${shq(cfg.model)}`);
  if (cfg.startDir) lines.push(`STARTDIR=${shq(cfg.startDir)}`);
  if (cfg.addDir) lines.push(`ADD_DIR=${shq(cfg.addDir)}`);
  if (cfg.thinkingLevel) lines.push(`THINKING_LEVEL=${cfg.thinkingLevel}`);
  if (cfg.fastMode !== undefined) lines.push(`FAST_MODE=${cfg.fastMode ? 1 : 0}`);
  if (cfg.autoTier !== undefined) lines.push(`AUTO_TIER=${cfg.autoTier ? 1 : 0}`);
  if (cfg.fleetTiers && cfg.fleetTiers.length > 0) {
    lines.push(`FLEET_TIERS=${cfg.fleetTiers.length}`);
    cfg.fleetTiers.forEach((t, i) => {
      lines.push(`FLEET_${i}=${t.modelAlias},${t.slots},${t.thinkingLevel},${t.fastMode ? 1 : 0}`);
    });
  }
  // RESUME_AT (epoch seconds) — emitted only when a real future-or-pending gate is
  // set, so a config without a custom resume time never carries a stale key. The
  // watchdog clears it (grep -v) once it elapses; drain-queue.sh drops it on launch.
  if (cfg.resumeAt && cfg.resumeAt > 0) lines.push(`RESUME_AT=${Math.floor(cfg.resumeAt)}`);
  for (const [k, v] of Object.entries(cfg.extra)) lines.push(`${k}=${shq(v)}`);
  return `${lines.join('\n')}\n`;
}

/** Apply a {@link DrainConfigPatch} to a config, returning a new config (immutable). */
export function applyDrainPatch(cfg: DrainConfig, patch: DrainConfigPatch): DrainConfig {
  const next: DrainConfig = { ...cfg, extra: { ...cfg.extra } };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.autoRestart !== undefined) next.autoRestart = patch.autoRestart;
  if (patch.jobs !== undefined) next.jobs = Math.max(1, Math.floor(patch.jobs));
  if (patch.model !== undefined) next.model = patch.model || undefined;
  if (patch.startDir !== undefined) next.startDir = patch.startDir || undefined;
  if (patch.addDir !== undefined) next.addDir = patch.addDir || undefined;
  if (patch.thinkingLevel !== undefined) next.thinkingLevel = patch.thinkingLevel;
  if (patch.fastMode !== undefined) next.fastMode = patch.fastMode;
  if (patch.autoTier !== undefined) next.autoTier = patch.autoTier;
  // resumeAt: a positive epoch sets the gate; 0 / negative / non-finite clears it.
  if (patch.resumeAt !== undefined) {
    next.resumeAt = Number.isFinite(patch.resumeAt) && patch.resumeAt > 0 ? Math.floor(patch.resumeAt) : undefined;
  }
  // Invariant: a disabled watchdog has no pending resume — turning ENABLED off
  // clears any custom next-start time (so re-arming later doesn't honor a stale one).
  if (next.enabled === false) next.resumeAt = undefined;
  // Fleet tiers: null / empty array clears fleet mode; otherwise validate + clamp each tier.
  if (patch.fleetTiers !== undefined) {
    if (!patch.fleetTiers || patch.fleetTiers.length === 0) {
      next.fleetTiers = undefined;
    } else {
      const tiers = sanitizeFleetTiers(patch.fleetTiers);
      next.fleetTiers = tiers.length > 0 ? tiers : undefined;
      if (next.fleetTiers) next.jobs = next.fleetTiers.reduce((s, t) => s + t.slots, 0);
    }
  }
  return next;
}

// ── fleet presets (named, reusable fleet configs, stored as fleet-presets.json) ─

/**
 * Parse `orchestration/fleet-presets.json` into a clean {@link FleetPreset} list:
 * tolerate a missing/garbage file (→ `[]`), drop entries without a usable name or
 * any valid tier, and re-derive each id from its name so the file stays the single
 * source of truth. Pure (no fs) so it's unit-tested directly.
 */
export function parseFleetPresets(text: string): FleetPreset[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { presets?: unknown })?.presets)
      ? (raw as { presets: unknown[] }).presets
      : [];
  const out: FleetPreset[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const tiers = sanitizeFleetTiers(Array.isArray(rec.tiers) ? (rec.tiers as FleetTier[]) : []);
    if (tiers.length === 0) continue;
    const id = fleetPresetId(name);
    if (seen.has(id)) continue; // first write wins on a duplicate name
    seen.add(id);
    const note = typeof rec.note === 'string' && rec.note.trim() ? rec.note.trim() : undefined;
    const updatedAt = typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : undefined;
    out.push({ id, name, tiers, note, updatedAt });
  }
  return out;
}

/** Serialize a {@link FleetPreset} list back to pretty `fleet-presets.json` text. */
export function serializeFleetPresets(presets: FleetPreset[]): string {
  return `${JSON.stringify(presets, null, 2)}\n`;
}

/**
 * Upsert a preset into a list by id (a slug of its name), so saving the same name
 * overwrites it. Returns a new, name-sorted list (immutable).
 */
export function upsertFleetPreset(presets: FleetPreset[], preset: FleetPreset): FleetPreset[] {
  const next = presets.filter((p) => p.id !== preset.id);
  next.push(preset);
  next.sort((a, b) => a.name.localeCompare(b.name));
  return next;
}

// ── fleet slots + coverage (the per-slot worker view + unservable tasks) ──────

/** Human model label for an alias ("opus" → "Opus 4.8"); falls back to the alias. */
export function modelLabelForAlias(alias: string): string {
  return FLEET_MODEL_OPTIONS.find((m) => m.alias === alias)?.label ?? alias;
}

/** Short model alias for a full model id; defaults to 'opus' when unmapped/absent. */
export function aliasForModelId(id: string | undefined): string {
  if (!id) return 'opus';
  return FLEET_MODEL_OPTIONS.find((m) => m.id === id)?.alias ?? 'opus';
}

/** Pick the highest thinking level among a set (by THINKING_LEVELS order); 'off' when none. */
function highestThinking(levels: (string | undefined)[]): ThinkingLevel {
  let best = 0;
  for (const l of levels) {
    const i = (THINKING_LEVELS as string[]).indexOf(l ?? '');
    if (i > best) best = i;
  }
  return THINKING_LEVELS[best] as ThinkingLevel;
}

/** Parse active-run.json's pipe-joined fleetConfig ("opus,1,high,0|sonnet,2,off,0") to tiers. */
export function parseFleetConfigString(s: string | undefined): FleetTier[] {
  if (!s) return [];
  const tiers: FleetTier[] = [];
  for (const part of s.split('|')) {
    const [alias, slots, think, fast] = part.split(',');
    if (!alias?.trim()) continue;
    tiers.push({
      modelAlias: alias.trim(),
      slots: Number.parseInt(slots ?? '1', 10) || 1,
      thinkingLevel: asThinkingLevel(think ?? '') ?? 'off',
      fastMode: truthy(fast ?? '0'),
    });
  }
  return sanitizeFleetTiers(tiers);
}

/** One configured worker slot's intended spec (before the live process is matched in). */
export interface SlotSpec {
  id: number;
  modelAlias: string;
  modelLabel: string;
  thinkingLevel: ThinkingLevel;
  fastMode: boolean;
  tier: number;
}

/**
 * Expand the EFFECTIVE config into one spec per worker slot — preferring what the
 * live drainer launched with (`activeRun`) over the saved config, so the worker
 * rows reflect what's actually running. Flat mode → `jobs` identical slots.
 */
export function effectiveSlots(running: boolean, activeRun: ActiveRun | undefined, config: DrainConfig): SlotSpec[] {
  let tiers: FleetTier[] = [];
  if (running && activeRun) {
    tiers = parseFleetConfigString(activeRun.fleetConfig);
    if (tiers.length === 0) {
      tiers = [
        {
          modelAlias: aliasForModelId(activeRun.model),
          slots: activeRun.jobs && activeRun.jobs > 0 ? activeRun.jobs : 1,
          thinkingLevel: asThinkingLevel(activeRun.thinkingLevel ?? '') ?? 'off',
          fastMode: truthy(activeRun.fastMode ?? '0'),
        },
      ];
    }
  } else if (config.fleetTiers?.length) {
    tiers = config.fleetTiers;
  } else {
    tiers = [
      {
        modelAlias: aliasForModelId(config.model),
        slots: config.jobs,
        thinkingLevel: config.thinkingLevel ?? 'off',
        fastMode: config.fastMode ?? false,
      },
    ];
  }
  const specs: SlotSpec[] = [];
  let id = 0;
  tiers.forEach((t, tier) => {
    for (let i = 0; i < t.slots; i++) {
      id += 1;
      specs.push({
        id,
        modelAlias: t.modelAlias,
        modelLabel: modelLabelForAlias(t.modelAlias),
        thinkingLevel: t.thinkingLevel,
        fastMode: t.fastMode,
        tier,
      });
    }
  });
  return specs;
}

export interface FleetSlotInput {
  running: boolean;
  drainPid?: number;
  specs: SlotSpec[];
  workers: WorkerProcess[];
  instances: WorkerInstance[];
  readyTasks: ReadyTask[];
}

/**
 * Combine each configured {@link SlotSpec} with the live worker process + claimed
 * task backing it into a color-codable {@link FleetSlot}. Status: `working` (alive +
 * a task), `waiting` (alive, no task — with a model-aware reason), `missing` (running
 * but no live process for this slot), `stopped` (drainer down).
 */
export function deriveFleetSlots(input: FleetSlotInput): FleetSlot[] {
  const { running, drainPid, specs, workers, instances, readyTasks } = input;
  const workerById = new Map(workers.map((w) => [w.id, w]));
  const instByWorker = new Map<number, WorkerInstance>();
  for (const inst of instances) if (inst.worker !== undefined) instByWorker.set(inst.worker, inst);
  // A ready task feeds a slot when it's untagged (any model) or tagged for this model.
  const modelHasReady = (alias: string) => readyTasks.some((t) => !t.model || t.model === alias);

  return specs.map((s) => {
    const w = workerById.get(s.id);
    const inst = instByWorker.get(s.id);
    const base: FleetSlot = {
      id: s.id,
      modelAlias: s.modelAlias,
      modelLabel: s.modelLabel,
      thinkingLevel: s.thinkingLevel,
      fastMode: s.fastMode,
      tier: s.tier,
      status: 'stopped',
      reason: '',
      drainPid: running ? drainPid : undefined,
      pid: w?.alive ? w.pid : undefined,
      endedAt: w?.lastFinishedAt,
      tasksCompleted: w?.tasksCompleted,
      lastErrored: w?.lastTaskErrored,
    };
    if (!running) return { ...base, status: 'stopped', reason: 'Drainer not running' };
    if (w?.alive && inst) {
      return {
        ...base,
        status: 'working',
        reason: 'On a task',
        task: inst.title,
        taskLine: inst.line,
        startedAt: inst.startedAt,
        elapsedSeconds: inst.elapsedSeconds,
      };
    }
    if (w?.alive) {
      return {
        ...base,
        status: 'waiting',
        reason: modelHasReady(s.modelAlias) ? 'Between tasks' : `No task for ${s.modelLabel}`,
      };
    }
    return { ...base, status: 'missing', reason: 'Worker not running — wake to relaunch' };
  });
}

/** The fleet's set of model aliases (the flat model counts as a one-alias fleet). */
function fleetAliases(config: DrainConfig): Set<string> {
  if (config.fleetTiers?.length) return new Set(config.fleetTiers.map((t) => t.modelAlias));
  return new Set([aliasForModelId(config.model)]);
}

/**
 * Which unblocked tasks no current tier can ever claim — the MODEL-MATCH rule: a
 * task tagged `(model:X)` needs a tier of alias X; untagged tasks any tier serves.
 * Thinking level is only clamped, never a blocker, so it doesn't make a task unservable.
 */
export function deriveUnservable(readyTasks: ReadyTask[], config: DrainConfig): UnservableSummary {
  const aliases = fleetAliases(config);
  const tasks = readyTasks.filter((t) => t.model && !aliases.has(t.model));
  const neededModels = [...new Set(tasks.map((t) => t.model as string))].sort();
  return { tasks, count: tasks.length, neededModels, autoTier: Boolean(config.autoTier) };
}

/**
 * The fleet tiers that would COVER every unservable task — the current tiers plus a
 * 1-slot tier per missing model (at the highest thinking level its tasks request).
 * Returns `[]` when nothing is unservable (no change needed).
 */
export function tiersToCoverUnservable(unservable: UnservableSummary, config: DrainConfig): FleetTier[] {
  if (unservable.count === 0) return [];
  const existing: FleetTier[] = config.fleetTiers?.length
    ? [...config.fleetTiers]
    : [
        {
          modelAlias: aliasForModelId(config.model),
          slots: config.jobs,
          thinkingLevel: config.thinkingLevel ?? 'off',
          fastMode: config.fastMode ?? false,
        },
      ];
  const have = new Set(existing.map((t) => t.modelAlias));
  const additions: FleetTier[] = [];
  for (const model of unservable.neededModels) {
    if (have.has(model)) continue;
    const think = highestThinking(unservable.tasks.filter((t) => t.model === model).map((t) => t.thinkingLevel));
    additions.push({ modelAlias: model, slots: 1, thinkingLevel: think, fastMode: false });
    have.add(model);
  }
  return additions.length ? [...existing, ...additions] : [];
}

// ── active-run.json (what the RUNNING drainer launched with) ──────────────────

/** Coerce an arbitrary JSON value to a finite integer, or `undefined`. */
function asInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Coerce a JSON value to a trimmed non-empty string, or `undefined`. */
function asStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return v == null ? undefined : String(v);
  const t = v.trim();
  return t || undefined;
}

/**
 * Parse `runs/active-run.json` (written by `drain-queue.sh` at startup) into an
 * {@link ActiveRun}. Tolerant: returns `undefined` for malformed/empty JSON or a
 * record with no usable pid (so a half-written file never throws).
 */
export function parseActiveRun(text: string): ActiveRun | undefined {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return undefined;
    obj = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const pid = asInt(obj.pid);
  if (pid === undefined || pid <= 0) return undefined;
  const run: ActiveRun = { pid };
  const pgid = asInt(obj.pgid);
  if (pgid !== undefined && pgid > 0) run.pgid = pgid;
  const startISO = asStr(obj.startISO);
  if (startISO) run.startISO = startISO;
  const jobs = asInt(obj.jobs);
  if (jobs !== undefined) run.jobs = jobs;
  // model/thinkingLevel/fastMode/startDir/addDir round-trip as raw strings (the
  // drainer writes thinkingLevel/fastMode possibly empty — keep '' distinguishable).
  if (typeof obj.model === 'string' && obj.model.trim()) run.model = obj.model.trim();
  if (typeof obj.thinkingLevel === 'string') run.thinkingLevel = obj.thinkingLevel.trim();
  if (typeof obj.fastMode === 'string') run.fastMode = obj.fastMode.trim();
  if (typeof obj.startDir === 'string' && obj.startDir.trim()) run.startDir = obj.startDir.trim();
  if (typeof obj.addDir === 'string' && obj.addDir.trim()) run.addDir = obj.addDir.trim();
  if (typeof obj.fleetConfig === 'string' && obj.fleetConfig.trim()) run.fleetConfig = obj.fleetConfig.trim();
  return run;
}

// ── pending diff (saved drain.config vs the running drainer) ──────────────────

/** Human label for each needs-restart setting (UI + pending markers). */
const NEEDS_RESTART_LABELS: Record<NeedsRestartField, string> = {
  jobs: 'Max instances (jobs)',
  model: 'Model',
  thinkingLevel: 'Thinking level',
  fastMode: 'Fast mode',
  startDir: 'Start dir',
  addDir: 'Add dir',
  fleetTiers: 'Fleet tiers',
};

/** Normalize a thinking level for comparison (empty/undefined → 'off'). */
function normThinking(v: string | undefined): string {
  const t = (v ?? '').trim().toLowerCase();
  return t || 'off';
}

/** Normalize a shell-ish boolean for comparison ('' / '0' / 'off' → false). */
function normBool(v: string | boolean | undefined): boolean {
  if (typeof v === 'boolean') return v;
  return /^(1|true|yes|on)$/i.test((v ?? '').trim());
}

/**
 * The needs-restart value the SAVED config currently holds, as a display string
 * (so the UI shows the same canonical form on both sides of the diff).
 */
function savedDisplay(cfg: DrainConfig, field: NeedsRestartField): string {
  switch (field) {
    case 'jobs':
      return String(cfg.jobs);
    case 'model':
      return cfg.model ?? DEFAULT_DRAIN_MODEL_LIB;
    case 'thinkingLevel':
      return normThinking(cfg.thinkingLevel);
    case 'fastMode':
      return cfg.fastMode ? 'on' : 'off';
    case 'startDir':
      return cfg.startDir ?? '';
    case 'addDir':
      return cfg.addDir ?? '';
    case 'fleetTiers':
      return cfg.fleetTiers && cfg.fleetTiers.length > 0 ? serializeFleetTiers(cfg.fleetTiers) : '(flat mode)';
  }
}

/** The needs-restart value the RUNNING drainer launched with, as a display string. */
function runningDisplay(run: ActiveRun, field: NeedsRestartField): string {
  switch (field) {
    case 'jobs':
      return run.jobs !== undefined ? String(run.jobs) : '';
    case 'model':
      return run.model ?? '';
    case 'thinkingLevel':
      return normThinking(run.thinkingLevel);
    case 'fastMode':
      return normBool(run.fastMode) ? 'on' : 'off';
    case 'startDir':
      return run.startDir ?? '';
    case 'addDir':
      return run.addDir ?? '';
    case 'fleetTiers':
      return run.fleetConfig ?? '(flat mode)';
  }
}

/** The drainer's built-in default model — re-declared locally to avoid a value import cycle. */
const DEFAULT_DRAIN_MODEL_LIB = 'claude-opus-4-8';

/**
 * Diff the SAVED config against what the RUNNING drainer launched with, over the
 * needs-restart settings only. Each differing setting becomes a {@link PendingChange}
 * (a "restart to apply" item). A field the active-run didn't record (older drainer)
 * is skipped — we can't know it diverged. Returns `[]` when nothing diverges.
 */
export function computePending(cfg: DrainConfig, run: ActiveRun | undefined): PendingChange[] {
  if (!run) return [];
  const out: PendingChange[] = [];
  for (const field of NEEDS_RESTART_FIELDS) {
    // Fleet tiers: special handling — compare serialized forms; skip if both sides are flat.
    if (field === 'fleetTiers') {
      const savedFleet = cfg.fleetTiers && cfg.fleetTiers.length > 0 ? serializeFleetTiers(cfg.fleetTiers) : '';
      const runningFleet = run.fleetConfig ?? '';
      // Only report pending when at least one side is in fleet mode.
      if ((savedFleet || runningFleet) && savedFleet !== runningFleet) {
        out.push({
          key: 'fleetTiers',
          label: NEEDS_RESTART_LABELS.fleetTiers,
          running: runningFleet || '(flat)',
          saved: savedFleet || '(flat)',
        });
      }
      continue;
    }
    // Skip fields the running drainer didn't record (can't assert a divergence).
    if (field === 'jobs' && run.jobs === undefined) continue;
    if (field === 'model' && run.model === undefined) continue;
    if (field === 'thinkingLevel' && run.thinkingLevel === undefined) continue;
    if (field === 'fastMode' && run.fastMode === undefined) continue;
    if (field === 'startDir' && run.startDir === undefined) continue;
    if (field === 'addDir' && run.addDir === undefined) continue;
    // In fleet mode, skip the flat-mode fields since they're superseded by fleet tiers.
    if (
      cfg.fleetTiers &&
      cfg.fleetTiers.length > 0 &&
      (field === 'jobs' || field === 'model' || field === 'thinkingLevel' || field === 'fastMode')
    )
      continue;
    const saved = savedDisplay(cfg, field);
    const running = runningDisplay(run, field);
    if (saved !== running) out.push({ key: field, label: NEEDS_RESTART_LABELS[field], running, saved });
  }
  return out;
}

/**
 * The config field names that actually changed between two configs (camelCase),
 * over the patchable fields. Used to decide whether an auto-restart is warranted
 * and to report back what a patch touched.
 */
export function changedDrainFields(prev: DrainConfig, next: DrainConfig): string[] {
  const fields: (keyof DrainConfig)[] = [
    'enabled',
    'autoRestart',
    'jobs',
    'model',
    'thinkingLevel',
    'fastMode',
    'startDir',
    'addDir',
  ];
  const changed = fields.filter((f) => (prev[f] ?? undefined) !== (next[f] ?? undefined));
  // Fleet tiers: JSON-compare since it's an array.
  const prevFleet = JSON.stringify(prev.fleetTiers ?? null);
  const nextFleet = JSON.stringify(next.fleetTiers ?? null);
  if (prevFleet !== nextFleet) changed.push('fleetTiers');
  return changed;
}

/** Whether any changed field is a needs-restart setting (so a restart would apply it). */
export function needsRestartFieldChanged(changed: string[]): boolean {
  return changed.some((f) => (NEEDS_RESTART_FIELDS as readonly string[]).includes(f));
}

// ── watchdog.status (one line: "<ISO>  <message>") ────────────────────────────

const ISO_RE = /\d{4}-\d{2}-\d{2}T[\d:.]+Z?/;

/**
 * Parse the last line of `watchdog.status` into a {@link WatchdogStatusLine}.
 * The watchdog overwrites this file every tick with `<ISO>  <human message>`;
 * we derive a coarse state + the ready count + runner-liveness it observed.
 */
export function parseWatchdogStatus(text: string): WatchdogStatusLine | undefined {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return undefined;

  const isoMatch = line.match(ISO_RE);
  const at = isoMatch?.[0];
  const message = at ? line.slice(line.indexOf(at) + at.length).trim() : line;

  let state: WatchdogStatusLine['state'] = 'unknown';
  if (/disabled/i.test(message)) state = 'disabled';
  else if (/launch/i.test(message)) state = 'launching';
  else if (/leave it/i.test(message)) state = 'leave';
  else if (/paused/i.test(message)) state = 'paused';
  else if (/idle/i.test(message)) state = 'idle';

  const readyMatch = message.match(/ready=(\d+)/i);
  const ready = readyMatch ? Number.parseInt(readyMatch[1], 10) : undefined;

  let running: boolean | undefined;
  if (/running=yes|already running/i.test(message)) running = true;
  else if (/running=no|no runner/i.test(message)) running = false;

  return { at, message, state, ready, running };
}

// ── launchd plist (StartInterval = the watchdog's tick interval) ──────────────

/** Pull the `<integer>`/`<string>` value following a `<key>NAME</key>` in a plist. */
function plistValue(xml: string, key: string, kind: 'integer' | 'string'): string | undefined {
  const re = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<${kind}>([^<]*)</${kind}>`, 'i');
  return xml.match(re)?.[1]?.trim();
}

/**
 * Parse the watchdog launchd plist for its label, tick interval, and program.
 * (The `exists` flag is stamped by the server; this pure parse assumes the XML
 * was read.) Tolerant of whitespace/newlines between the key and its value.
 */
export function parseLaunchdPlist(xml: string): Omit<LaunchdInfo, 'exists'> {
  const label = plistValue(xml, 'Label', 'string');
  const intervalRaw = plistValue(xml, 'StartInterval', 'integer');
  const intervalSeconds = intervalRaw ? Number.parseInt(intervalRaw, 10) : undefined;
  // ProgramArguments holds the interpreter + the script; the script is the .sh.
  const program = xml.match(/<string>([^<]*\.sh)<\/string>/i)?.[1]?.trim();
  return {
    ...(label ? { label } : {}),
    ...(intervalSeconds && Number.isFinite(intervalSeconds) ? { intervalSeconds } : {}),
    ...(program ? { program } : {}),
  };
}

/**
 * Return the plist XML with its `StartInterval` set to `seconds` — a pure string
 * transform (the server writes the result + reloads launchctl). If the key is
 * absent it's inserted before the closing `</dict>`.
 */
export function setPlistInterval(xml: string, seconds: number): string {
  const n = Math.max(1, Math.floor(seconds));
  const re = /(<key>\s*StartInterval\s*<\/key>\s*<integer>)([^<]*)(<\/integer>)/i;
  if (re.test(xml)) return xml.replace(re, (_m, a, _old, c) => `${a}${n}${c}`);
  // No StartInterval yet — insert one just before the dict closes.
  return xml.replace(/(\s*)<\/dict>/i, `$1  <key>StartInterval</key>$1  <integer>${n}</integer>$1</dict>`);
}

// ── Derivations from the board (in-progress instances + problems) ─────────────

/** Known repo names we can spot in a task title / worktree slug. */
const REPO_HINTS: [RegExp, string][] = [
  [/\bcursed\s*alchemy\b|\bcursedalchemy\b/i, 'cursedalchemy'],
  [/\brubato\b/i, 'rubato'],
  [/\bcwip\b/i, 'cwip'],
];

/** Best-effort repo from a free-text title (+ optional worktree slug). */
export function repoFromText(...texts: (string | undefined)[]): string | undefined {
  const hay = texts.filter(Boolean).join(' ');
  for (const [re, name] of REPO_HINTS) if (re.test(hay)) return name;
  return undefined;
}

/** Elapsed whole-seconds between an ISO start and `nowMs` (or `undefined`). */
function elapsedSeconds(startIso: string | undefined, nowMs: number): number | undefined {
  if (!startIso) return undefined;
  const t = Date.parse(startIso);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/**
 * The worker slot a worktree slug belongs to, when it's a persistent drain
 * worktree (`_drain-w<n>`, the documented per-slot reuse path). Returns `undefined`
 * for a one-off descriptive slug — there's no worker number to show then.
 */
export function workerIdFromWorktree(worktree: string | undefined): number | undefined {
  const m = worktree?.match(/_drain-w(\d+)\b/i);
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * In-progress instances: one per `[~]` claimed task, with the live elapsed time
 * since it was claimed, its body text (so the dashboard can show what's in
 * progress), and the worker slot running it when the worktree is a `_drain-w<n>`
 * reuse path. Repo comes from the heading meta, else is inferred from the
 * title/worktree.
 */
export function deriveInstances(board: WorkflowBoard, nowMs: number): WorkerInstance[] {
  return board.groups.claimed.map((t) => ({
    title: t.title,
    ...(t.body ? { body: t.body } : {}),
    repo: t.meta.repo ?? repoFromText(t.title, t.meta.worktree),
    worktree: t.meta.worktree,
    ...(workerIdFromWorktree(t.meta.worktree) ? { worker: workerIdFromWorktree(t.meta.worktree) } : {}),
    startedAt: t.meta.start,
    elapsedSeconds: elapsedSeconds(t.meta.start, nowMs),
    line: t.line,
    ...(t.meta.model ? { model: t.meta.model } : {}),
    ...(t.meta.thinkingLevel ? { thinkingLevel: t.meta.thinkingLevel } : {}),
  }));
}

/** A claim older than this (with no live runner) is flagged as possibly stale. */
const STALE_INSTANCE_SECONDS = 60 * 60; // 1h

/** Inputs the problem-deriver needs (all already read by the server). */
export interface ProblemInput {
  board: WorkflowBoard;
  config: DrainConfig;
  running: boolean;
  instances: WorkerInstance[];
  /** Bare names of worker `.err` files that have content. */
  workerErrors: { file: string; excerpt: string }[];
  /** Live worker processes right now (per-worker PID files that are alive). */
  liveWorkers?: number;
  /** Fleet-coverage summary — drives the "tasks no tier can run" problem. */
  unservable?: UnservableSummary;
}

/**
 * Surface the attention items a human cares about: blocked tasks, worker error
 * output, the watchdog being paused while work is queued, a long-running claim
 * with no live runner (likely an instance that died mid-task), "ready work but
 * nothing draining it", and a drainer running short-handed (fewer live workers
 * than the configured fan-out, with queued work the missing workers could take).
 */
export function deriveProblems(input: ProblemInput): Problem[] {
  const { board, config, running, instances, workerErrors, unservable } = input;
  const liveWorkers = input.liveWorkers ?? 0;
  const problems: Problem[] = [];

  for (const t of board.groups.blocked) {
    problems.push({
      kind: 'blocked',
      title: t.title,
      detail: t.meta.reason,
      severity: 'warn',
      category: 'Blocked',
      fields: [
        { label: 'Task', value: t.title },
        ...(t.meta.reason ? [{ label: 'Reason', value: t.meta.reason }] : []),
      ],
      fix: { action: 'none', label: 'Needs you' },
    });
  }
  for (const e of workerErrors) {
    problems.push({
      kind: 'worker-error',
      title: e.file,
      detail: e.excerpt,
      severity: 'error',
      category: 'Worker',
      fields: [{ label: 'Log', value: e.file }],
      fix: { action: 'restart', label: 'Restart drainer' },
    });
  }
  const ready = board.counts.ready;
  if (ready > 0 && !config.enabled) {
    problems.push({
      kind: 'watchdog-disabled',
      title: `${ready} ready task(s) but the watchdog is paused`,
      detail: 'ENABLED=0 — the watchdog will not auto-start a drainer. Resume it to drain the queue.',
      severity: 'warn',
      category: 'Paused',
      fields: [{ label: 'Ready', value: String(ready) }],
      fix: { action: 'enable', label: 'Enable watchdog' },
    });
  }
  if (ready > 0 && config.enabled && !running) {
    problems.push({
      kind: 'no-runner',
      title: `${ready} ready task(s) and no drainer running`,
      detail: 'The watchdog should start one on its next tick; start one now if you want it immediately.',
      severity: 'warn',
      category: 'Idle',
      fields: [{ label: 'Ready', value: String(ready) }],
      fix: { action: 'start', label: 'Start drainer now', auto: true },
    });
  }
  // A drainer is up but running short-handed: fewer live workers than the
  // configured fan-out, AND there's more queued work than the live workers can
  // pick up in parallel right now (so the missing workers are actually costing
  // throughput). Threshold `ready > liveWorkers` avoids nagging about the
  // expected tail of a queue (a few workers finishing the last task or two). The
  // single-lock drainer can't add workers to itself, so the fix is "Wake
  // workers" (relaunch at the configured count) — see `wakeAction`.
  if (running && liveWorkers < config.jobs && ready > liveWorkers) {
    const missing = config.jobs - liveWorkers;
    problems.push({
      kind: 'missing-workers',
      title: `${liveWorkers}/${config.jobs} workers running — ${missing} missing, ${ready} task(s) queued`,
      detail:
        'The drainer is running with fewer workers than configured — some exited, or you raised the job count after it started (a running drainer can’t add workers to itself). Use “Wake workers” to relaunch it at the configured count; any in-flight task resumes in its worktree.',
      severity: 'warn',
      category: 'Capacity',
      fields: [
        { label: 'Live', value: `${liveWorkers}/${config.jobs}` },
        { label: 'Missing', value: String(missing) },
        { label: 'Queued', value: String(ready) },
      ],
      fix: { action: 'wake', label: 'Wake workers' },
    });
  }
  if (unservable && unservable.count > 0) {
    problems.push({
      kind: 'unservable-tasks',
      title: `${unservable.count} ready task(s) no tier can run`,
      detail: `These tasks are tagged for a model no fleet tier provides (${unservable.neededModels.join(
        ', ',
      )}), so no worker can ever claim them. Add a tier for each needed model — or turn on auto-tier to grow the fleet automatically.`,
      severity: 'warn',
      category: 'Coverage',
      fields: [
        { label: 'Tasks', value: String(unservable.count) },
        { label: 'Needs', value: unservable.neededModels.map(modelLabelForAlias).join(' + ') },
      ],
      fix: unservable.autoTier
        ? { action: 'add-tier', label: 'Auto-tier on', auto: true }
        : { action: 'add-tier', label: 'Add capable tier(s)' },
    });
  }
  if (!running) {
    for (const inst of instances) {
      if ((inst.elapsedSeconds ?? 0) >= STALE_INSTANCE_SECONDS) {
        problems.push({
          kind: 'stale-instance',
          title: `Claimed >1h ago, no live runner: ${inst.title}`,
          detail: 'The instance that claimed this may have died — review the task and re-open it ([~]→[ ]) if so.',
          severity: 'warn',
          category: 'Stale',
          fields: [
            { label: 'Task', value: inst.title },
            { label: 'Age', value: '>1h' },
          ],
          fix: { action: 'none', label: 'Review task' },
        });
      }
    }
  }
  return problems;
}

// ── "Wake workers" decision (relaunch the drainer at the configured count) ────

/** What `wakeWorkers` should do, given the current drainer + worker state. */
export type WakeAction = 'start' | 'noop' | 'restart';

/**
 * Decide how to bring the live worker count up to the configured fan-out — the
 * pure core of the dashboard's "Wake workers" button:
 *   - `start`   — nothing is running, so just launch a drainer at `jobs`.
 *   - `noop`    — a drainer is up and already has ≥ `jobs` live workers.
 *   - `restart` — a drainer is up but short-handed (workers exited, or `jobs`
 *                 was raised after it started). A single-lock drainer can't be
 *                 topped up from outside, so it must be relaunched at `jobs`
 *                 (in-flight claims resume in their worktrees → no work lost).
 */
export function wakeAction(input: { running: boolean; liveWorkers: number; jobs: number }): WakeAction {
  const jobs = Math.max(1, Math.floor(input.jobs));
  if (!input.running) return 'start';
  return input.liveWorkers >= jobs ? 'noop' : 'restart';
}

// ── watchdog.tick.json (last tick: start/end/duration/result) ─────────────────

/**
 * Parse `orchestration/watchdog.tick.json` (written by `watchdog.sh` each tick)
 * into a {@link WatchdogTick}. Tolerant: returns `undefined` for malformed/empty
 * JSON; maps the script's `startISO`/`endISO` keys to `startedAt`/`finishedAt`.
 */
export function parseWatchdogTick(text: string): WatchdogTick | undefined {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return undefined;
    obj = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const tick: WatchdogTick = {};
  const startedAt = asStr(obj.startISO);
  if (startedAt) tick.startedAt = startedAt;
  const finishedAt = asStr(obj.endISO);
  if (finishedAt) tick.finishedAt = finishedAt;
  const durationMs = asInt(obj.durationMs);
  if (durationMs !== undefined && durationMs >= 0) tick.durationMs = durationMs;
  const result = asStr(obj.result);
  if (result) tick.result = result;
  // A record with no usable fields isn't worth surfacing.
  if (tick.startedAt === undefined && tick.finishedAt === undefined && tick.result === undefined) return undefined;
  return tick;
}

// ── Next watchdog tick (last check + interval) ────────────────────────────────

/** Compute the next watchdog tick (ISO) from the last check + the interval. */
export function nextRunIso(lastCheckIso: string | undefined, intervalSeconds: number | undefined): string | undefined {
  if (!lastCheckIso || !intervalSeconds) return undefined;
  const t = Date.parse(lastCheckIso);
  if (Number.isNaN(t)) return undefined;
  return new Date(t + intervalSeconds * 1000).toISOString();
}

/** How the watchdog's next action reads, given its armed/loaded/resume state. */
export interface NextRun {
  /** Next launchd tick (ISO) — when the watchdog is loaded + armed. */
  nextRunAt?: string;
  /** Pending custom resume time (ISO) — when a future RESUME_AT gate is set. */
  resumeAt?: string;
  /** Coarse mode the UI renders: agent stopped, disabled, paused-until-resume, or scheduled. */
  mode: 'unloaded' | 'disabled' | 'paused' | 'scheduled';
}

/**
 * Resolve the watchdog's next-run picture from its current state — the single
 * source of truth behind the dashboard's "Next run" line:
 *   - launchd agent not loaded → `unloaded` (it isn't ticking at all → "—").
 *   - loaded but ENABLED=0     → `disabled` (ticks no-op → "—").
 *   - armed + a future RESUME_AT → `paused` (ticks idle until `resumeAt`).
 *   - armed, no pending resume → `scheduled` (next tick = last tick + interval).
 * `loaded === undefined` (couldn't query launchctl, e.g. tests) is treated as
 * loaded so the next-tick estimate still shows.
 */
export function deriveNextRun(input: {
  enabled: boolean;
  loaded?: boolean;
  /** RESUME_AT as epoch SECONDS, when set. */
  resumeAtEpoch?: number;
  /** ISO start of the last tick (preferred) or last status check. */
  lastTickIso?: string;
  intervalSeconds?: number;
  nowMs: number;
}): NextRun {
  if (input.loaded === false) return { mode: 'unloaded' };
  if (!input.enabled) return { mode: 'disabled' };
  const nextTick = nextRunIso(input.lastTickIso, input.intervalSeconds);
  if (input.resumeAtEpoch && input.resumeAtEpoch > 0 && input.resumeAtEpoch * 1000 > input.nowMs) {
    return {
      mode: 'paused',
      resumeAt: new Date(input.resumeAtEpoch * 1000).toISOString(),
      ...(nextTick ? { nextRunAt: nextTick } : {}),
    };
  }
  return { mode: 'scheduled', ...(nextTick ? { nextRunAt: nextTick } : {}) };
}

// ── Shell-command catalogue (real paths, for the "run it yourself" panel) ─────

/** The resolved paths the command catalogue references. */
export interface CommandPaths {
  runner: string;
  watchdogScript: string;
  plist: string;
  label: string;
  queue: string;
  runsDir: string;
  watchdogLog: string;
  watchdogStatus: string;
  lock: string;
}

/**
 * Build the copy-pasteable shell-command catalogue (with real resolved paths) so
 * the UI/CLI can show exactly what to run for manual control + observability —
 * mirroring the commands documented in the findings note.
 */
export function buildWatchdogCommands(p: CommandPaths): WatchdogCommand[] {
  return [
    // observe
    {
      id: 'wd-loaded',
      label: 'Is the watchdog loaded?',
      description: 'List the launchd agent (empty = not loaded).',
      command: `launchctl list | grep ${p.label.split('.').pop() ?? 'agent-drain'}`,
      category: 'observe',
    },
    {
      id: 'wd-status',
      label: 'Watchdog last check',
      description: 'The single status line the watchdog overwrites each tick.',
      command: `cat ${p.watchdogStatus}`,
      category: 'observe',
    },
    {
      id: 'ready-count',
      label: 'Ready task count',
      description: 'How many `## [ ]` tasks are waiting in the board.',
      command: `grep -cE '^## \\[ \\]' ${p.queue}`,
      category: 'observe',
    },
    {
      id: 'runner-live',
      label: 'Is a drainer running?',
      description: 'Check the drainer PID lockfile against a live process.',
      command: `pid=$(cat ${p.lock} 2>/dev/null); kill -0 "$pid" 2>/dev/null && echo "running (PID $pid)" || echo "no runner"`,
      category: 'observe',
    },
    // logs
    {
      id: 'tail-watchdog',
      label: 'Tail the watchdog log',
      description: 'Follow the watchdog’s launch events.',
      command: `tail -f ${p.watchdogLog}`,
      category: 'logs',
    },
    {
      id: 'tail-workers',
      label: 'Tail the workers',
      description: 'Follow every per-worker run JSONL as it appends.',
      command: `tail -f ${p.runsDir}/run-*-w*.jsonl`,
      category: 'logs',
    },
    // control
    {
      id: 'start-default',
      label: 'Start a drain (saved settings)',
      description: 'Run the drainer with the JOBS saved in drain.config.',
      command: p.runner,
      category: 'control',
    },
    {
      id: 'start-jobs',
      label: 'Start a drain with 3 workers',
      description: 'Run the drainer fanning out to 3 concurrent instances.',
      command: `${p.runner} -j 3`,
      category: 'control',
    },
    {
      id: 'disable',
      label: 'Disable auto-restart',
      description: 'Set ENABLED=0 so the watchdog stops auto-starting drains.',
      command: `${p.runner} --disable`,
      category: 'control',
    },
    {
      id: 'stop-drain',
      label: 'Stop an in-flight drain',
      description: 'Hard-stop the drainer and any live `claude -p` workers.',
      command: `pkill -f drain-queue.sh ; pkill -f 'claude -p'`,
      category: 'control',
    },
    {
      id: 'wd-stop',
      label: 'Stop the watchdog',
      description: 'Unload the launchd agent (no more auto-restart ticks).',
      command: `launchctl unload ${p.plist}`,
      category: 'control',
    },
    {
      id: 'wd-start',
      label: 'Start the watchdog',
      description: 'Load the launchd agent so it ticks again.',
      command: `launchctl load -w ${p.plist}`,
      category: 'control',
    },
  ];
}
