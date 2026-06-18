/**
 * Pluggable local-diffusion adapter. Each backend speaks a DIFFERENT protocol —
 * the common "POST {prompt} → raw PNG" idea is a myth — so we normalize them to a
 * single `generateImageBuffer()` that returns PNG bytes:
 *
 *   - fooocus  (Fooocus-API, :8888) → POST /v2/generation/text-to-image, JSON in,
 *                                      JSON out with base64 (require_base64). DEFAULT.
 *   - a1111    (SD WebUI,    :7860) → POST /sdapi/v1/txt2img → { images: [base64] }
 *   - comfyui  (:8188)             → needs a workflow-graph template; not wired yet
 *                                      (throws a clear, actionable error).
 *
 * A connection failure surfaces as `DiffusionOfflineError` with a friendly message
 * so the UI/route can tell the user to boot their diffusion server, never crash.
 */

import type { ArtBackend } from '../../lib/appApis';

export interface DiffusionRequest {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
}

export interface DiffusionDeps {
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Abort/timeout signal (generation is slow; callers set a long timeout). */
  signal?: AbortSignal;
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
    // fetch rejects (ECONNREFUSED / DNS / abort) → the server isn't reachable.
    throw new DiffusionOfflineError(baseUrl, err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Diffusion server ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res;
}

/** Fooocus-API (default): JSON in, JSON out with base64 images. */
async function fooocus(baseUrl: string, req: DiffusionRequest, deps: DiffusionDeps): Promise<Buffer> {
  const doFetch = deps.fetch ?? fetch;
  const res = await diffusionFetch(
    doFetch,
    `${trimUrl(baseUrl)}/v2/generation/text-to-image`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: req.prompt,
        negative_prompt: req.negativePrompt,
        // Fooocus takes its aspect ratio as a "<w>*<h>" string.
        aspect_ratios_selection: `${req.width}*${req.height}`,
        image_number: 1,
        require_base64: true,
        async_process: false,
      }),
      signal: deps.signal,
    },
    baseUrl,
  );
  const data = (await res.json()) as Array<{ base64?: string | null; url?: string | null }>;
  const first = Array.isArray(data) ? data[0] : undefined;
  if (first?.base64) return base64ToBuffer(first.base64);
  if (first?.url) {
    // Some Fooocus setups return a URL instead of inline base64 — fetch the bytes.
    const imgRes = await diffusionFetch(doFetch, first.url, { signal: deps.signal }, baseUrl);
    return Buffer.from(await imgRes.arrayBuffer());
  }
  throw new Error('Fooocus-API returned no image (no base64 or url in the response)');
}

/** AUTOMATIC1111 / SD WebUI: { images: [base64] }. */
async function a1111(baseUrl: string, req: DiffusionRequest, deps: DiffusionDeps): Promise<Buffer> {
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
      }),
      signal: deps.signal,
    },
    baseUrl,
  );
  const data = (await res.json()) as { images?: string[] };
  const first = data.images?.[0];
  if (!first) throw new Error('SD WebUI returned no images');
  return base64ToBuffer(first);
}

/** ComfyUI: requires a baked workflow-graph template; intentionally not wired yet. */
async function comfyui(): Promise<Buffer> {
  throw new Error(
    'ComfyUI backend is not wired yet — it needs a workflow-graph template (POST /prompt → poll /history → /view). ' +
      'Set art.backend to "fooocus" or "a1111" for now.',
  );
}

/** Generate one image, returning PNG bytes, via the configured backend. */
export async function generateImageBuffer(
  backend: ArtBackend,
  url: string,
  req: DiffusionRequest,
  deps: DiffusionDeps = {},
): Promise<Buffer> {
  switch (backend) {
    case 'fooocus':
      return fooocus(url, req, deps);
    case 'a1111':
      return a1111(url, req, deps);
    case 'comfyui':
      return comfyui();
    default:
      throw new Error(`Unknown art backend "${backend}"`);
  }
}
