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
import { DEFAULT_BACKEND_URL, type DiffusionDeps, generateImageBuffer } from './diffusion';

/** Per-request generation timeout — diffusion is slow; don't hang forever either. */
const GENERATION_TIMEOUT_MS = 180_000;

export interface ResolvedArtConfig {
  enabled: boolean;
  backend: ArtBackend;
  url: string;
  steps: number;
}

/** Resolve the art config with defaults (backend → fooocus, url → backend default, steps → 4). */
export async function resolveArtConfig(): Promise<ResolvedArtConfig> {
  const art = (await loadConfig()).art ?? {};
  const backend = art.backend ?? 'fooocus';
  return {
    enabled: art.enabled ?? true,
    backend,
    url: art.url ?? DEFAULT_BACKEND_URL[backend],
    steps: art.steps ?? 4,
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
  const width = input.width ?? 1024;
  const height = input.height ?? 1024;
  const { prompt, negativePrompt } = enrichPrompt(input.prompt, input.preset);
  // Visible in the server log so an agent/user can see exactly what was synthesized.
  console.log(`[art] ${cfg.backend} ${width}x${height} (${input.preset}) → ${prompt}`);

  const bytes = await generateImageBuffer(
    cfg.backend,
    cfg.url,
    { prompt, negativePrompt, width, height, steps: cfg.steps },
    { signal: deps.signal ?? AbortSignal.timeout(GENERATION_TIMEOUT_MS), fetch: deps.fetch },
  );

  const dir = appAssetsDir(appId);
  await mkdir(dir, { recursive: true });
  const fileName = `art_asset_${Date.now()}_${randomUUID().slice(0, 8)}.png`;
  const absPath = resolve(dir, fileName);
  await writeFile(absPath, bytes);

  return { success: true, url: assetUrl(appId, fileName), path: absPath, fileName, appId, enrichedPrompt: prompt };
}

export interface AssetListItem {
  fileName: string;
  url: string;
}

/** List an app's generated assets, newest first (by the timestamp in the filename). */
export async function listAssets(appId: string): Promise<AssetListItem[]> {
  const dir = appAssetsDir(appId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no dir yet → no assets
  }
  return names
    .filter((n) => n.toLowerCase().endsWith('.png'))
    .sort((a, b) => b.localeCompare(a)) // art_asset_<ts>_… → lexicographic desc ≈ newest first
    .map((fileName) => ({ fileName, url: assetUrl(appId, fileName) }));
}
