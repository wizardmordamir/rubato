/**
 * Orchestrates one art-generation request: resolve config → enrich the prompt →
 * call the configured diffusion backend → write the PNG under
 * `<RUBATO_HOME>/generated-assets/<appId>/` → return the servable URL + metadata.
 * Pure I/O + glue; the protocol lives in ./diffusion and the styling in the enricher.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { enrichPrompt } from '../../lib/ai/promptEnricher';
import type { ArtBackend, ArtPresetType } from '../../lib/appApis';
import { GENERATED_ASSETS_DIR, loadConfig } from '../../lib/config';
import {
  clampNumber,
  cleanStyleStack,
  DEFAULT_PERFORMANCE,
  type FooocusPerformance,
  normalizeArtStyles,
  normalizePerformance,
} from '../../shared/art';
import type { ArtGeneration } from '../../shared/types';
import { insertArtGeneration, listArtGenerations } from '../db';
import { DEFAULT_BACKEND_URL, type DiffusionDeps, generateImageBuffer } from './diffusion';

/**
 * Per-request generation timeout. SDXL on Apple-Silicon MPS is slow — a single
 * "Quality" (60-step) Fooocus generation with the V2 prompt expander runs ~3-4
 * min — so this is generous; don't hang forever either.
 */
const GENERATION_TIMEOUT_MS = 300_000;

export interface ResolvedArtConfig {
  enabled: boolean;
  backend: ArtBackend;
  url: string;
  steps: number;
  styles: string[];
  performance: FooocusPerformance;
  guidanceScale: number;
  sharpness: number;
  baseModel?: string;
  refinerModel?: string;
  refinerSwitch: number;
  /** Default generation size when a request doesn't override it. */
  width: number;
  height: number;
  negativePrompt: string;
}

/**
 * Resolve the art config with quality-tuned defaults: fooocus backend, the
 * "Fooocus V2" prompt-expansion style stack, Speed performance (Quality is
 * available; Lightning needs an extra LoRA), and Fooocus's desktop-app guidance
 * (4.0) + sharpness (2.0).
 */
export async function resolveArtConfig(): Promise<ResolvedArtConfig> {
  const art = (await loadConfig()).art ?? {};
  const backend = art.backend ?? 'fooocus';
  return {
    enabled: art.enabled ?? true,
    backend,
    url: art.url ?? DEFAULT_BACKEND_URL[backend],
    steps: art.steps ?? 4,
    // The configured default may include live engine styles, so clean (not curated-filter) it.
    styles: cleanStyleStack(art.styles),
    performance: art.performance ?? DEFAULT_PERFORMANCE,
    guidanceScale: art.guidanceScale ?? 4.0,
    sharpness: art.sharpness ?? 2.0,
    baseModel: art.baseModel,
    refinerModel: art.refinerModel,
    refinerSwitch: clampNumber(art.refinerSwitch, 0.1, 1.0) ?? 0.8,
    width: clampNumber(art.width, 256, 2048) ?? 1024,
    height: clampNumber(art.height, 256, 2048) ?? 1024,
    negativePrompt: art.negativePrompt ?? '',
  };
}

/**
 * Filesystem-safe app id (a single path segment, no dots → no traversal). `__global`
 * when empty. Dots are dropped entirely so a value can never contain `..`.
 */
export function sanitizeAppId(appId: string | undefined): string {
  const clean = (appId ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean || '__global';
}

/** Absolute directory holding a given app's generated assets. */
export function appAssetsDir(appId: string): string {
  return resolve(GENERATED_ASSETS_DIR, sanitizeAppId(appId));
}

/** Public URL the UI/agent uses to load a generated asset. */
export function assetUrl(appId: string, fileName: string): string {
  return `/api/generated-assets/${encodeURIComponent(sanitizeAppId(appId))}/${encodeURIComponent(fileName)}`;
}

export interface GenerateArtInput {
  appId?: string;
  prompt: string;
  preset: ArtPresetType;
  width?: number;
  height?: number;
  /** Override the negative prompt (else the preset's). Co-pilot crafts its own. */
  negativePrompt?: string;
  /** Fooocus style stack override (else the configured default). */
  styles?: string[];
  /** Performance preset override (Quality/Speed). */
  performance?: FooocusPerformance;
  /** Guidance/CFG override. */
  guidanceScale?: number;
  /** Sharpness override. */
  sharpness?: number;
  /** Seed for reproducible/varied output (else random). */
  seed?: number;
  /** Base checkpoint override. */
  baseModel?: string;
  /** Refiner checkpoint override, or "None" to disable. */
  refinerModel?: string;
  /** Refiner switch point override (0.1–1.0). */
  refinerSwitch?: number;
}

export interface GenerateArtResult {
  success: true;
  /** Servable URL: GET /api/generated-assets/<appId>/<file>. */
  url: string;
  /** Absolute path on disk. */
  path: string;
  fileName: string;
  appId: string;
  /** The final positive prompt sent to the model (for tracking/debug). */
  enrichedPrompt: string;
  /** The negative prompt sent. */
  negativePrompt: string;
  /** Fooocus style stack applied. */
  styles: string[];
  /** Performance preset used. */
  performance: string;
  width: number;
  height: number;
  preset: ArtPresetType;
  backend: ArtBackend;
  /** The seed the engine reported using (when available) — for reproduction. */
  seed?: number;
}

/**
 * Generate one asset and persist it. Throws on disabled engine, an offline
 * diffusion server (DiffusionOfflineError), or a write failure — the caller maps
 * those to a friendly HTTP response.
 */
export async function generateArt(input: GenerateArtInput, deps: DiffusionDeps = {}): Promise<GenerateArtResult> {
  const cfg = await resolveArtConfig();
  if (!cfg.enabled) throw new Error('Art generation is disabled (set `art.enabled` in ~/.rubato/config.json).');

  const appId = sanitizeAppId(input.appId);
  // Fall back to the configured default size (a memory/speed lever) before the
  // hard 1024² floor, so lowering `art.width/height` shrinks unspecified requests.
  const width = input.width ?? cfg.width;
  const height = input.height ?? cfg.height;

  // Positive prompt: preset modifiers enrich the subject. Negative prompt: the
  // caller's override (the co-pilot crafts its own) else the preset's, with the
  // configured global negative folded in (deduped).
  const { prompt, negativePrompt: presetNeg } = enrichPrompt(input.prompt, input.preset);
  const negParts = [input.negativePrompt ?? presetNeg, cfg.negativePrompt].map((s) => s.trim()).filter(Boolean);
  const negativePrompt = [...new Set(negParts)].join(', ');

  // Validate/clamp untrusted inputs (the route forwards raw body values) so a bad
  // value falls back to a sane default rather than reaching the engine as a 400.
  // A per-request override is untrusted → curated-filter it; otherwise use the
  // already-cleaned configured default (which may carry live engine styles).
  const styles = input.styles ? normalizeArtStyles(input.styles) : cfg.styles;
  const performance = normalizePerformance(input.performance) ?? cfg.performance;
  const guidanceScale = clampNumber(input.guidanceScale, 1, 30) ?? cfg.guidanceScale;
  const sharpness = clampNumber(input.sharpness, 0, 30) ?? cfg.sharpness;
  const requestSeed = input.seed != null ? clampNumber(Math.trunc(input.seed), -1, 2_147_483_647) : undefined;
  const baseModel = input.baseModel ?? cfg.baseModel;
  const refinerModel = input.refinerModel ?? cfg.refinerModel;
  const refinerSwitch = clampNumber(input.refinerSwitch, 0.1, 1.0) ?? cfg.refinerSwitch;

  // Visible in the server log so an agent/user can see exactly what was synthesized.
  console.log(`[art] ${cfg.backend} ${width}x${height} ${performance} [${styles.join(', ')}] → ${prompt}`);

  const { image, seed } = await generateImageBuffer(
    cfg.backend,
    cfg.url,
    {
      prompt,
      negativePrompt,
      width,
      height,
      steps: cfg.steps,
      styles,
      performance,
      guidanceScale,
      sharpness,
      seed: requestSeed,
      baseModel,
      refinerModel,
      refinerSwitch,
    },
    { signal: deps.signal ?? AbortSignal.timeout(GENERATION_TIMEOUT_MS), fetch: deps.fetch },
  );

  const dir = appAssetsDir(appId);
  await mkdir(dir, { recursive: true });
  // 12 hex chars (48 bits) of UUID after the ms timestamp makes a same-ms filename
  // collision (and a lost ledger row) negligible.
  const fileName = `art_asset_${Date.now()}_${randomUUID().slice(0, 12)}.png`;
  const absPath = resolve(dir, fileName);
  await writeFile(absPath, image);

  const usedSeed = seed ?? requestSeed;
  // Record the ledger row (best-effort: a DB hiccup must not lose the image).
  try {
    insertArtGeneration({
      appId,
      fileName,
      prompt: input.prompt,
      enrichedPrompt: prompt,
      negativePrompt,
      preset: input.preset,
      styles,
      performance,
      backend: cfg.backend,
      width,
      height,
      guidanceScale,
      sharpness,
      seed: usedSeed,
      model: baseModel,
      generatedAt: Date.now(),
    });
  } catch (err) {
    console.warn(`[art] failed to record generation ledger row: ${err instanceof Error ? err.message : err}`);
  }

  return {
    success: true,
    url: assetUrl(appId, fileName),
    path: absPath,
    fileName,
    appId,
    enrichedPrompt: prompt,
    negativePrompt,
    styles,
    performance,
    width,
    height,
    preset: input.preset,
    backend: cfg.backend,
    seed: usedSeed,
  };
}

export interface AssetListItem {
  fileName: string;
  url: string;
  /** Full generation metadata, when this image was recorded in the ledger. */
  meta?: ArtGeneration;
}

/**
 * List an app's generated assets, newest first (by the timestamp in the
 * filename), each joined with its ledger metadata when present. Images generated
 * before the ledger existed simply have no `meta`.
 */
export async function listAssets(appId: string): Promise<AssetListItem[]> {
  // Sanitize once up front: the ledger stores the SANITIZED app id (generateArt
  // inserts the sanitized value), so the join key below must match it.
  const safeId = sanitizeAppId(appId);
  const dir = appAssetsDir(safeId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no dir yet → no assets
  }
  const metaByFile = new Map<string, ArtGeneration>();
  try {
    for (const row of listArtGenerations(safeId)) metaByFile.set(row.fileName, row);
  } catch {
    // ledger read is best-effort enrichment; fall back to bare file listing.
  }
  return names
    .filter((n) => n.toLowerCase().endsWith('.png'))
    .sort((a, b) => b.localeCompare(a)) // art_asset_<ts>_… → lexicographic desc ≈ newest first
    .map((fileName) => ({ fileName, url: assetUrl(safeId, fileName), meta: metaByFile.get(fileName) }));
}
