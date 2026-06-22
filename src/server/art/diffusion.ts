/**
 * Pluggable local-diffusion adapter. Each backend speaks a DIFFERENT protocol —
 * the common "POST {prompt} → raw PNG" idea is a myth — so we normalize them to a
 * single `generateImageBuffer()` that returns PNG bytes:
 *
 *   - fooocus  (Fooocus-API, :8888) → POST /v1/generation/text-to-image, JSON in,
 *                                      JSON out with base64 (require_base64). DEFAULT.
 *   - a1111    (SD WebUI,    :7860) → POST /sdapi/v1/txt2img → { images: [base64] }
 *   - comfyui  (:8188)             → needs a workflow-graph template; not wired yet
 *                                      (throws a clear, actionable error).
 *
 * A connection failure surfaces as `DiffusionOfflineError` with a friendly message
 * so the UI/route can tell the user to boot their diffusion server, never crash.
 */

import type { ArtBackend } from '../../lib/appApis';
import type { FooocusPerformance } from '../../shared/art';
import { comfyui as comfyuiAdapter, listComfyuiModels as listComfyuiModelsImpl } from './comfyui';

export interface DiffusionRequest {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  /** Fooocus style stack (e.g. ["Fooocus V2","Fooocus Enhance"]). fooocus-only. */
  styles?: string[];
  /** Fooocus performance preset (Quality/Speed/…). Controls step count. fooocus-only. */
  performance?: FooocusPerformance;
  /** CFG / guidance scale. Higher = follows the prompt more literally. */
  guidanceScale?: number;
  /** Fooocus sharpness (0–30). fooocus-only. */
  sharpness?: number;
  /** Seed for reproducibility; -1 / undefined = random. */
  seed?: number;
  /** Base checkpoint filename override (must exist in the server's models dir). */
  baseModel?: string;
  /** Refiner checkpoint filename, or "None" to disable (a real memory lever). fooocus-only. */
  refinerModel?: string;
  /** Refiner switch point (0.1–1.0). fooocus-only. */
  refinerSwitch?: number;
}

/** One generated image plus the seed the backend actually used (for reproducibility). */
export interface DiffusionResult {
  image: Buffer;
  /** The seed used, when the backend reports it (Fooocus + a1111 do). */
  seed?: number;
}

export interface DiffusionDeps {
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Abort/timeout signal (generation is slow; callers set a long timeout). */
  signal?: AbortSignal;
  /**
   * Override the ComfyUI history-poll interval in ms (default 2000). Injectable
   * for tests so they don't have to wait real wall-clock time between polls.
   */
  pollIntervalMs?: number;
}

/** Default base URL per backend. */
export const DEFAULT_BACKEND_URL: Record<ArtBackend, string> = {
  fooocus: 'http://localhost:8888',
  a1111: 'http://localhost:7860',
  comfyui: 'http://localhost:8188',
};

/** The local diffusion server couldn't be reached — caller turns this into a friendly UI message. */
export class DiffusionOfflineError extends Error {
  constructor(
    readonly url: string,
    cause?: unknown,
  ) {
    super(`Local diffusion engine offline at ${url}. Please boot Fooocus/ComfyUI/SD-WebUI to unlock art generation.`);
    this.name = 'DiffusionOfflineError';
    if (cause) this.cause = cause;
  }
}

/** Generation ran past the timeout — distinct from "offline" (the server IS up, just slow). */
export class DiffusionTimeoutError extends Error {
  constructor(cause?: unknown) {
    super(
      'Image generation timed out — the diffusion model is slow on this hardware. ' +
        'Try the "Speed" performance preset or a smaller size, and make sure no other generation is running.',
    );
    this.name = 'DiffusionTimeoutError';
    if (cause) this.cause = cause;
  }
}

/** True when an error is an abort/timeout from an AbortSignal (vs. a real connection failure). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Decode a base64 image string (tolerating a `data:` URL prefix) into PNG bytes. */
function base64ToBuffer(b64: string): Buffer {
  const clean = b64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').trim();
  return Buffer.from(clean, 'base64');
}

/** Normalize a base URL: drop a trailing slash so we can append clean paths. */
function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Wrap a fetch so a connection failure (server down / refused) becomes a typed
 * DiffusionOfflineError, while an HTTP error response becomes a normal Error
 * carrying the status + a snippet of the body.
 */
async function diffusionFetch(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  baseUrl: string,
): Promise<Response> {
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch (err) {
    // An aborted signal = our own timeout firing (the server is up, just slow) —
    // never report that as "offline / go boot your server".
    if (isAbortError(err)) throw new DiffusionTimeoutError(err);
    // Otherwise fetch rejected (ECONNREFUSED / DNS) → the server isn't reachable.
    throw new DiffusionOfflineError(baseUrl, err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Diffusion server ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res;
}

/** A single result row from the Fooocus-API text-to-image endpoint. */
interface FooocusImageResult {
  base64?: string | null;
  url?: string | null;
  seed?: string | number | null;
  finish_reason?: string | null;
}

/** Parse a seed value (Fooocus returns it as a string) into a number, if present. */
function parseSeed(seed: string | number | null | undefined): number | undefined {
  if (seed == null) return undefined;
  const n = typeof seed === 'number' ? seed : Number.parseInt(seed, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Fooocus-API (default): JSON in, JSON out with base64 images. Sends the full
 * high-quality parameter surface — style stack (incl. the "Fooocus V2" prompt
 * expander), performance preset, guidance, sharpness, and an explicit seed — so
 * output quality matches the desktop Fooocus app, not a bare 6-field call.
 */
async function fooocus(baseUrl: string, req: DiffusionRequest, deps: DiffusionDeps): Promise<DiffusionResult> {
  const doFetch = deps.fetch ?? fetch;
  const body: Record<string, unknown> = {
    prompt: req.prompt,
    negative_prompt: req.negativePrompt,
    // Fooocus takes its aspect ratio as a "<w>*<h>" string.
    aspect_ratios_selection: `${req.width}*${req.height}`,
    image_number: 1,
    image_seed: req.seed ?? -1,
    require_base64: true,
    async_process: false,
    // Headless engine: never render progress previews or keep intermediate image
    // buffers — they only feed a live UI and cost memory we want back (the user's
    // 32 GB-RAM problem). The final image is unaffected.
    advanced_params: { disable_preview: true, disable_intermediate_results: true },
  };
  if (req.styles?.length) body.style_selections = req.styles;
  if (req.performance) body.performance_selection = req.performance;
  if (req.guidanceScale != null) body.guidance_scale = req.guidanceScale;
  if (req.sharpness != null) body.sharpness = req.sharpness;
  if (req.baseModel) body.base_model_name = req.baseModel;
  if (req.refinerModel) body.refiner_model_name = req.refinerModel;
  if (req.refinerSwitch != null) body.refiner_switch = req.refinerSwitch;

  const res = await diffusionFetch(
    doFetch,
    // The plain text-to-image endpoint is /v1 (the /v2 twin is "…-with-ip", for
    // image prompts only). Both take the same CommonRequest body.
    `${trimUrl(baseUrl)}/v1/generation/text-to-image`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: deps.signal,
    },
    baseUrl,
  );
  const data = (await res.json()) as FooocusImageResult[];
  const first = Array.isArray(data) ? data[0] : undefined;
  // Fooocus reports per-image success/failure rather than an HTTP error.
  if (first?.finish_reason && first.finish_reason !== 'SUCCESS') {
    throw new Error(`Fooocus generation did not succeed (${first.finish_reason}).`);
  }
  const seed = parseSeed(first?.seed);
  if (first?.base64) return { image: base64ToBuffer(first.base64), seed };
  if (first?.url) {
    // Some Fooocus setups return a URL instead of inline base64 — fetch the bytes.
    const imgRes = await diffusionFetch(doFetch, first.url, { signal: deps.signal }, baseUrl);
    return { image: Buffer.from(await imgRes.arrayBuffer()), seed };
  }
  throw new Error('Fooocus-API returned no image (no base64 or url in the response)');
}

/** AUTOMATIC1111 / SD WebUI: { images: [base64], info } — info carries the seed. */
async function a1111(baseUrl: string, req: DiffusionRequest, deps: DiffusionDeps): Promise<DiffusionResult> {
  const doFetch = deps.fetch ?? fetch;
  const res = await diffusionFetch(
    doFetch,
    `${trimUrl(baseUrl)}/sdapi/v1/txt2img`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: req.prompt,
        negative_prompt: req.negativePrompt,
        width: req.width,
        height: req.height,
        steps: req.steps,
        ...(req.seed != null ? { seed: req.seed } : {}),
        ...(req.guidanceScale != null ? { cfg_scale: req.guidanceScale } : {}),
      }),
      signal: deps.signal,
    },
    baseUrl,
  );
  const data = (await res.json()) as { images?: string[]; info?: string };
  const first = data.images?.[0];
  if (!first) throw new Error('SD WebUI returned no images');
  let seed: number | undefined;
  try {
    seed = data.info ? parseSeed((JSON.parse(data.info) as { seed?: number }).seed) : undefined;
  } catch {
    // info is best-effort JSON; ignore if it isn't parseable.
  }
  return { image: base64ToBuffer(first), seed };
}

/**
 * Discover available model filenames from a running ComfyUI server.
 * Calls GET /object_info/<LoaderNodeType> and extracts the first input enum.
 * Returns [] when the server is offline or the template has no recognized loader.
 */
export async function listComfyuiModels(baseUrl: string, deps: DiffusionDeps = {}): Promise<string[]> {
  return listComfyuiModelsImpl(baseUrl, deps);
}

/** Generate one image (PNG bytes + the seed used) via the configured backend. */
export async function generateImageBuffer(
  backend: ArtBackend,
  url: string,
  req: DiffusionRequest,
  deps: DiffusionDeps = {},
): Promise<DiffusionResult> {
  switch (backend) {
    case 'fooocus':
      return fooocus(url, req, deps);
    case 'a1111':
      return a1111(url, req, deps);
    case 'comfyui':
      return comfyuiAdapter(url, req, deps);
    default:
      throw new Error(`Unknown art backend "${backend}"`);
  }
}
