/**
 * Art-tuning service: the read/save model behind the `/art-tuning` page, plus thin
 * proxies to the live Fooocus-API that turn its own endpoints into helpful, safe
 * controls. The headline goal is RAM relief on a 32 GB machine — see the memory
 * levers in src/shared/fooocus.ts (`memoryArgs`) and `cleanFooocusVram` below.
 *
 *   getArtTuning()    → resolved generation defaults + memory/VRAM flags (+ preview)
 *   saveArtTuning()   → validate/clamp a partial patch, persist to ~/.rubato/config.json
 *   fooocusOptions()  → GET /v1/engines/all-models + /v1/engines/styles (populate pickers)
 *   fooocusStats()    → host memory gauge + GET /v1/generation/job-queue (is a job running?)
 *   cleanFooocusVram()→ GET /v1/engines/clean_vram (unload models, free memory NOW)
 *
 * Every proxy degrades gracefully when Fooocus is offline (never throws to the route).
 */

import { freemem, totalmem } from 'node:os';
import type { ArtConfig } from '../../lib/appApis';
import { loadConfig, saveConfig } from '../../lib/config';
import { clampNumber, cleanStyleStack, normalizePerformance } from '../../shared/art';
import {
  type ArtTuningState,
  type ArtTuningValues,
  type FooocusMemoryConfig,
  type FooocusOptions,
  type FooocusStats,
  type FooocusVramMode,
  memoryArgs,
} from '../../shared/fooocus';
import { resolveArtConfig } from './generateImage';

/** Short timeout for the live API proxies — these back interactive UI, never a generation. */
const PROBE_TIMEOUT_MS = 4000;

const MB = 1024 * 1024;
const toMb = (bytes: number): number => Math.round(bytes / MB);

const VRAM_MODES: ReadonlySet<FooocusVramMode> = new Set(['auto', 'high', 'normal', 'low', 'minimal', 'cpu']);

/** The base URL of the configured Fooocus backend (defaults to localhost:8888). */
async function fooocusUrl(): Promise<string> {
  return (await resolveArtConfig()).url.replace(/\/+$/, '');
}

// ---- Read / save tuning ------------------------------------------------------

/** Resolve the current tuning state (generation defaults + memory flags + preview). */
export async function getArtTuning(): Promise<ArtTuningState> {
  const cfg = await resolveArtConfig();
  const memory = (await loadConfig()).fooocus?.memory ?? {};
  const art: ArtTuningValues = {
    enabled: cfg.enabled,
    backend: cfg.backend,
    url: cfg.url,
    performance: cfg.performance,
    guidanceScale: cfg.guidanceScale,
    sharpness: cfg.sharpness,
    styles: cfg.styles,
    baseModel: cfg.baseModel ?? '',
    refinerModel: cfg.refinerModel ?? '',
    refinerSwitch: cfg.refinerSwitch,
    width: cfg.width,
    height: cfg.height,
    negativePrompt: cfg.negativePrompt,
  };
  return { art, memory, launchArgs: memoryArgs(memory) };
}

/** A partial tuning patch from the UI (every field optional; raw/untrusted values). */
export interface ArtTuningPatch {
  art?: Partial<Record<keyof ArtTuningValues, unknown>>;
  memory?: Record<string, unknown>;
}

/** Coerce an untrusted memory blob into a valid FooocusMemoryConfig. */
function validateMemory(raw: Record<string, unknown> | undefined): FooocusMemoryConfig {
  if (!raw) return {};
  const vram =
    typeof raw.vram === 'string' && VRAM_MODES.has(raw.vram as FooocusVramMode)
      ? (raw.vram as FooocusVramMode)
      : 'auto';
  return {
    vram,
    fp16: raw.fp16 === true,
    attentionSplit: raw.attentionSplit === true,
    offloadFromVram: raw.offloadFromVram === true,
    disableOffload: raw.disableOffload === true,
  };
}

/** Build a validated, clamped `art` config patch from untrusted UI values. */
function validateArtPatch(raw: Partial<Record<keyof ArtTuningValues, unknown>> | undefined): Partial<ArtConfig> {
  const patch: Partial<ArtConfig> = {};
  if (!raw) return patch;
  if (typeof raw.enabled === 'boolean') patch.enabled = raw.enabled;
  const perf = normalizePerformance(raw.performance);
  if (perf) patch.performance = perf;
  const guidance = clampNumber(raw.guidanceScale, 1, 30);
  if (guidance != null) patch.guidanceScale = guidance;
  const sharpness = clampNumber(raw.sharpness, 0, 30);
  if (sharpness != null) patch.sharpness = sharpness;
  const refinerSwitch = clampNumber(raw.refinerSwitch, 0.1, 1.0);
  if (refinerSwitch != null) patch.refinerSwitch = refinerSwitch;
  const width = clampNumber(raw.width, 256, 2048);
  if (width != null) patch.width = Math.round(width);
  const height = clampNumber(raw.height, 256, 2048);
  if (height != null) patch.height = Math.round(height);
  if (Array.isArray(raw.styles))
    patch.styles = cleanStyleStack(raw.styles.filter((s): s is string => typeof s === 'string'));
  if (typeof raw.baseModel === 'string') patch.baseModel = raw.baseModel.trim() || undefined;
  // 'None' is a real, meaningful value (disable the refiner) — keep it; '' clears the override.
  if (typeof raw.refinerModel === 'string') patch.refinerModel = raw.refinerModel.trim() || undefined;
  if (typeof raw.negativePrompt === 'string') patch.negativePrompt = raw.negativePrompt;
  return patch;
}

/**
 * Apply a partial tuning patch and persist it. `art` fields merge over the stored
 * config; `memory` replaces the memory block wholesale (the UI always sends the
 * full set). Returns the fresh resolved state.
 */
export async function saveArtTuning(patch: ArtTuningPatch): Promise<ArtTuningState> {
  const cfg = await loadConfig();
  const artPatch = validateArtPatch(patch.art);
  cfg.art = { ...cfg.art, ...artPatch };
  if (patch.memory !== undefined) {
    cfg.fooocus = { ...cfg.fooocus, memory: validateMemory(patch.memory) };
  }
  await saveConfig(cfg);
  return getArtTuning();
}

// ---- Live Fooocus-API proxies (graceful when offline) ------------------------

/** GET a Fooocus-API endpoint as JSON, or null on any failure (offline/timeout/error). */
async function fooocusGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${await fooocusUrl()}${path}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Live engine options for the pickers: installed checkpoints + LoRAs
 * (`/v1/engines/all-models`) and the full legal style list (`/v1/engines/styles`).
 * `offline:true` when the engine can't be reached (the UI then falls back to its
 * curated lists).
 */
export async function fooocusOptions(): Promise<FooocusOptions> {
  const [models, styles] = await Promise.all([
    fooocusGet<{ model_filenames?: string[]; lora_filenames?: string[] }>('/v1/engines/all-models'),
    fooocusGet<string[]>('/v1/engines/styles'),
  ]);
  const offline = models === null && styles === null;
  return {
    models: models?.model_filenames ?? [],
    loras: models?.lora_filenames ?? [],
    styles: Array.isArray(styles) ? styles : [],
    offline,
  };
}

/** Host memory gauge + (best-effort) whether a generation is currently running. */
export async function fooocusStats(): Promise<FooocusStats> {
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  const host = {
    totalMb: toMb(total),
    freeMb: toMb(free),
    usedMb: toMb(used),
    usedPct: total > 0 ? Math.round((used / total) * 100) : 0,
  };
  const processRssMb = toMb(process.memoryUsage().rss);

  // Fooocus-API's job-queue exposes `running_size` = the combined running+waiting
  // count (there is no separate pending field); >0 means a generation is in flight.
  const jq = await fooocusGet<{ running_size?: number }>('/v1/generation/job-queue');
  const queue = jq ? { running: (jq.running_size ?? 0) > 0, active: jq.running_size ?? 0 } : null;
  return { host, processRssMb, queue };
}

/**
 * Unload all models and free VRAM/RAM immediately via `GET /v1/engines/clean_vram`.
 * The direct answer to "I'm idle but Fooocus is still eating my 32 GB" — no restart,
 * no reconfigure. Models reload lazily on the next generation.
 */
export async function cleanFooocusVram(): Promise<{ ok: boolean; message: string }> {
  const result = await fooocusGet<{ message?: string }>('/v1/engines/clean_vram');
  if (result === null) {
    return { ok: false, message: 'Fooocus API is not reachable — start it first, then try again.' };
  }
  return { ok: true, message: 'Unloaded all models and freed memory.' };
}
