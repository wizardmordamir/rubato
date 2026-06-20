/**
 * Fooocus control — wire types shared by the rubato server and the chat-page
 * control panel. The server can start/stop two local Fooocus processes and
 * report their status by probing their ports:
 *   - `api` → Fooocus-API (default :8888), the JSON server rubato's art engine
 *     calls (POST /v2/generation/text-to-image).
 *   - `ui`  → the standalone Fooocus Gradio web UI (default :7865).
 *
 * "running" is decided by a live port probe (the source of truth), so an
 * instance you started by hand is reflected too. "managed" means rubato spawned
 * the process in this server session — the one case where rubato will stop it.
 * An externally-started server is left alone (rubato ignores it).
 */

import type { FooocusPerformance } from './art';

export type FooocusServerId = 'api' | 'ui';

export interface FooocusServerStatus {
  id: FooocusServerId;
  /** Human label, e.g. "Fooocus API" / "Fooocus Web UI". */
  label: string;
  /** Port it listens on. */
  port: number;
  /** Base URL the panel links to and the probe hits. */
  url: string;
  /** The port answered an HTTP request — the authoritative "is it up?" signal. */
  running: boolean;
  /** rubato spawned this process this session, so rubato may stop it. */
  managed: boolean;
  /** Spawned by rubato but not yet answering (e.g. loading models) → "Starting…". */
  starting: boolean;
  /** The install dir + entry script were found, so it can be started. */
  installed: boolean;
  /** Resolved install dir (for display/tooltip), or null when not found on disk. */
  dir: string | null;
  /** Last start/stop failure or unexpected exit, surfaced to the UI. */
  error?: string;
}

export interface FooocusStatus {
  api: FooocusServerStatus;
  ui: FooocusServerStatus;
}

// ---- Memory / VRAM tuning ----------------------------------------------------
//
// Fooocus-API shares Fooocus's own arg parser (see fooocusapi/args.py →
// `ldm_patched.modules.args_parser`), so these launch flags reach the engine
// when passed to `main.py`. On Apple Silicon "VRAM" is unified system RAM, so the
// VRAM strategy is the single biggest lever on the 32 GB-RAM problem: lower modes
// offload model weights out of memory aggressively (slower, but far lighter).
// These are LAUNCH flags — changing them needs a Fooocus restart to take effect.

/** VRAM management strategy → a Fooocus `--always-*-vram` launch flag. */
export type FooocusVramMode = 'auto' | 'high' | 'normal' | 'low' | 'minimal' | 'cpu';

/**
 * Structured Fooocus memory tuning (`~/.rubato/config.json` → `fooocus.memory`).
 * The manager translates this into `main.py` launch args via {@link memoryArgs}.
 * Everything is optional; an empty object means "let Fooocus auto-detect" (its
 * default — which on a high-RAM machine tends to keep models resident and balloon).
 */
export interface FooocusMemoryConfig {
  /** VRAM strategy. `auto` adds no flag (Fooocus decides). Default `auto`. */
  vram?: FooocusVramMode;
  /** `--all-in-fp16`: run everything in half precision — roughly halves model memory. */
  fp16?: boolean;
  /** `--attention-split`: memory-efficient (sub-quadratic) attention — less peak RAM, a bit slower. */
  attentionSplit?: boolean;
  /** `--always-offload-from-vram`: move weights out of memory between steps (lightest, slowest). */
  offloadFromVram?: boolean;
  /** `--disable-offload-from-vram`: keep weights resident (fastest, heaviest). Ignored if {@link offloadFromVram}. */
  disableOffload?: boolean;
}

/** Display metadata for the VRAM modes (UI picker), heaviest → lightest. */
export const FOOOCUS_VRAM_MODES: { value: FooocusVramMode; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: 'Auto',
    hint: 'Let Fooocus detect — default; tends to keep models resident on high-RAM machines.',
  },
  { value: 'high', label: 'High (fastest)', hint: 'Keep everything in memory. Fastest, heaviest — avoid on 32 GB.' },
  { value: 'normal', label: 'Normal', hint: 'Balanced residency.' },
  {
    value: 'low',
    label: 'Low (recommended for 32 GB)',
    hint: 'Offload aggressively between stages. Much lighter, a little slower.',
  },
  { value: 'minimal', label: 'Minimal', hint: 'Smallest footprint that still uses the GPU/MPS. Slowest GPU mode.' },
  { value: 'cpu', label: 'CPU only', hint: 'No GPU/MPS at all. Lightest on VRAM but very slow — last resort.' },
];

/** Map a VRAM mode to its launch flag, or null for `auto` (no flag). */
function vramFlag(mode: FooocusVramMode | undefined): string | null {
  switch (mode) {
    case 'high':
      return '--always-high-vram';
    case 'normal':
      return '--always-normal-vram';
    case 'low':
      return '--always-low-vram';
    case 'minimal':
      return '--always-no-vram';
    case 'cpu':
      return '--always-cpu';
    default:
      return null; // 'auto' / undefined → let Fooocus decide
  }
}

/**
 * Translate a memory config into the Fooocus `main.py` launch flags it implies.
 * Pure + order-stable, so it's unit-testable and the UI can preview the exact
 * args. `offloadFromVram` wins over `disableOffload` (they're mutually exclusive).
 */
export function memoryArgs(cfg: FooocusMemoryConfig | undefined): string[] {
  if (!cfg) return [];
  const args: string[] = [];
  const flag = vramFlag(cfg.vram);
  if (flag) args.push(flag);
  if (cfg.fp16) args.push('--all-in-fp16');
  if (cfg.attentionSplit) args.push('--attention-split');
  if (cfg.offloadFromVram) args.push('--always-offload-from-vram');
  else if (cfg.disableOffload) args.push('--disable-offload-from-vram');
  return args;
}

/** A built-in memory preset (the one-click "make it lighter / faster" bundles). */
export interface FooocusMemoryPreset {
  key: string;
  label: string;
  description: string;
  memory: FooocusMemoryConfig;
}

/**
 * Curated memory presets. `light` is the headline answer to "running out of
 * 32 GB RAM" — aggressive offload + fp16 + split attention. `balanced` clears the
 * heavy flags; `performance` keeps models resident for speed when RAM allows.
 */
export const FOOOCUS_MEMORY_PRESETS: FooocusMemoryPreset[] = [
  {
    key: 'light',
    label: '🪶 Light (low RAM)',
    description: 'Aggressive offload + fp16 + split attention. Best for 32 GB; slower but rarely runs out.',
    memory: { vram: 'low', fp16: true, attentionSplit: true, offloadFromVram: true, disableOffload: false },
  },
  {
    key: 'balanced',
    label: '⚖️ Balanced',
    description: 'Normal residency, fp16 on. A good middle ground.',
    memory: { vram: 'normal', fp16: true, attentionSplit: false, offloadFromVram: false, disableOffload: false },
  },
  {
    key: 'performance',
    label: '🚀 Performance (high RAM)',
    description: 'Keep models resident for speed. Only when you have memory to spare.',
    memory: { vram: 'high', fp16: false, attentionSplit: false, offloadFromVram: false, disableOffload: true },
  },
];

/** Badge tone vocabulary (mirrors the UI Badge component's tones). */
export type FooocusTone = 'neutral' | 'accent' | 'success' | 'warn' | 'error';

/** Presentational view of one server's status — pure, so it's unit-testable. */
export interface FooocusServerView {
  tone: FooocusTone;
  /** Short status label for the badge. */
  text: string;
  /** Whether the toggle should be interactive (can act on the current state). */
  toggleEnabled: boolean;
  /** When the toggle is disabled, why — shown as a tooltip. Empty when enabled. */
  reason: string;
}

/**
 * Derive the badge tone + toggle affordance for a server's status. The toggle is
 * actionable only when the action makes sense:
 *  - stopped + installed → can start.
 *  - running + managed-by-rubato → can stop.
 * It is disabled (with a reason) while starting, when not installed (can't
 * start), or when running but external (rubato won't stop what it didn't start).
 */
export function fooocusServerView(s: FooocusServerStatus): FooocusServerView {
  if (s.starting) {
    return {
      tone: 'warn',
      text: 'Starting…',
      toggleEnabled: false,
      reason: 'Booting — can take a minute while models load.',
    };
  }
  if (s.running && s.managed) {
    return { tone: 'success', text: 'Running', toggleEnabled: true, reason: '' };
  }
  if (s.running) {
    return {
      tone: 'accent',
      text: 'Running · external',
      toggleEnabled: false,
      reason: 'Started outside rubato — stop it where you launched it.',
    };
  }
  if (!s.installed) {
    return {
      tone: 'error',
      text: 'Not installed',
      toggleEnabled: false,
      reason: `Couldn't find Fooocus on disk. Set fooocus.${s.id}.dir in ~/.rubato/config.json.`,
    };
  }
  return { tone: 'neutral', text: 'Stopped', toggleEnabled: true, reason: '' };
}

// ---- Art Tuning wire types ---------------------------------------------------
// Shared by the tuning page (GET/POST /api/art/tuning) and the live-options /
// stats proxies. `backend` is a loose string here to avoid a shared→lib import
// (the canonical ArtBackend union lives in lib/appApis.ts).

/** The resolved, editable generation defaults the tuning page renders + saves. */
export interface ArtTuningValues {
  enabled: boolean;
  backend: string;
  url: string;
  performance: FooocusPerformance;
  guidanceScale: number;
  sharpness: number;
  styles: string[];
  /** '' = engine default checkpoint. */
  baseModel: string;
  /** '' = engine default refiner; 'None' = refiner disabled (memory lever). */
  refinerModel: string;
  refinerSwitch: number;
  width: number;
  height: number;
  negativePrompt: string;
}

/** Full tuning state: per-generation defaults + memory/VRAM flags + their preview. */
export interface ArtTuningState {
  art: ArtTuningValues;
  memory: FooocusMemoryConfig;
  /** The exact launch flags `memory` implies (shown as a restart preview). */
  launchArgs: string[];
}

/** Live, engine-discovered options (proxied from Fooocus-API). `offline` when unreachable. */
export interface FooocusOptions {
  models: string[];
  loras: string[];
  styles: string[];
  offline: boolean;
}

/** Host memory snapshot (MB) — the gauge that makes the RAM pressure visible. */
export interface HostMemory {
  totalMb: number;
  freeMb: number;
  usedMb: number;
  usedPct: number;
}

/** Poll payload: host memory + rubato's own RSS + whether a generation is in flight. */
export interface FooocusStats {
  host: HostMemory;
  processRssMb: number;
  /** `active` = Fooocus's running+waiting job count (`running_size`); null when the engine is unreachable. */
  queue: { running: boolean; active: number } | null;
}
