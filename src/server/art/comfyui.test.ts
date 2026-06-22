/**
 * Unit tests for the ComfyUI adapter (comfyui.ts).
 *
 * All HTTP calls are mocked — no live ComfyUI server is required. The tests
 * verify the three-step API flow (POST /prompt → poll /history → GET /view),
 * workflow patching (prompt/seed/model/dimensions/guidance), and dynamic model
 * discovery via GET /object_info.
 */

import { describe, expect, test } from 'bun:test';
import { comfyui, listComfyuiModels } from './comfyui';
import type { DiffusionRequest } from './diffusion';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PNG_BYTES = Buffer.from('fake-png-data');

const BASE_REQ: DiffusionRequest = {
  prompt: 'a wizard casting a spell',
  negativePrompt: 'blurry, text',
  width: 1024,
  height: 1024,
  steps: 4,
  guidanceScale: 3.5,
  seed: 42,
};

const BASE_URL = 'http://localhost:8188';

// ── Fetch-stub helpers ────────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

/**
 * Build a multi-step fetch stub for the three-call ComfyUI flow:
 *   1. POST /prompt  → { prompt_id }
 *   2. GET  /history → { [promptId]: { outputs: { … } } }  (may be empty on first poll)
 *   3. GET  /view    → PNG bytes
 */
function comfyuiFlowFetch(
  opts: {
    promptId?: string;
    /** How many empty-history polls before the "done" one. */
    emptyPolls?: number;
    filename?: string;
    subfolder?: string;
  } = {},
): { fetch: typeof fetch; calls: Call[] } {
  const promptId = opts.promptId ?? 'abc-123';
  const emptyPolls = opts.emptyPolls ?? 0;
  const filename = opts.filename ?? 'ComfyUI_00001_.png';
  const subfolder = opts.subfolder ?? '';

  const calls: Call[] = [];
  let historyCallCount = 0;

  const fetchStub = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });

    const u = url as string;

    // 1. POST /prompt
    if (u.endsWith('/prompt') && method === 'POST') {
      return new Response(JSON.stringify({ prompt_id: promptId, number: 1, node_errors: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 2. GET /history/{promptId}
    if (u.includes('/history/')) {
      historyCallCount++;
      // Return empty history for the first `emptyPolls` calls.
      if (historyCallCount <= emptyPolls) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      const doneHistory = {
        [promptId]: {
          outputs: {
            '9': {
              images: [{ filename, subfolder, type: 'output' }],
            },
          },
          status: { completed: true },
        },
      };
      return new Response(JSON.stringify(doneHistory), { status: 200 });
    }

    // 3. GET /view
    if (u.includes('/view')) {
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    }

    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  return { fetch: fetchStub, calls };
}

// ── Tests: adapter flow ───────────────────────────────────────────────────────

describe('comfyui adapter', () => {
  test('completes the full flow: POST /prompt → poll /history → GET /view', async () => {
    const { fetch, calls } = comfyuiFlowFetch();

    const result = await comfyui(BASE_URL, BASE_REQ, { fetch, pollIntervalMs: 0 });

    expect(result.image.toString()).toBe(PNG_BYTES.toString());

    // Call 1: POST /prompt
    expect(calls[0].url).toBe(`${BASE_URL}/prompt`);
    expect(calls[0].method).toBe('POST');

    // Call 2: GET /history/{promptId}
    expect(calls[1].url).toContain('/history/abc-123');

    // Call 3: GET /view with filename
    expect(calls[2].url).toContain('/view');
    expect(calls[2].url).toContain('filename=ComfyUI_00001_.png');
    expect(calls[2].url).toContain('type=output');
  });

  test('waits through empty history polls before the image is ready', async () => {
    const { fetch, calls } = comfyuiFlowFetch({ emptyPolls: 2 });

    // pollIntervalMs: 0 skips the real 2s wait so the test is instant.
    const result = await comfyui(BASE_URL, BASE_REQ, { fetch, pollIntervalMs: 0 });

    expect(result.image.toString()).toBe(PNG_BYTES.toString());
    // 1 prompt + 3 history calls (2 empty + 1 done) + 1 view = 5 total.
    expect(calls.filter((c) => c.url.includes('/history/')).length).toBe(3);
  });

  test('patches the positive prompt into CLIPTextEncode nodes', async () => {
    const { fetch, calls } = comfyuiFlowFetch();

    await comfyui(BASE_URL, { ...BASE_REQ, prompt: 'a dragon breathing fire' }, { fetch, pollIntervalMs: 0 });

    const promptBody = calls[0].body as {
      prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    };
    const textNode = Object.values(promptBody.prompt).find((n) => n.class_type === 'CLIPTextEncode');
    expect(textNode?.inputs.text).toBe('a dragon breathing fire');
  });

  test('patches seed into RandomNoise node (fixed seed)', async () => {
    const { fetch, calls } = comfyuiFlowFetch();

    await comfyui(BASE_URL, { ...BASE_REQ, seed: 9999 }, { fetch, pollIntervalMs: 0 });

    const promptBody = calls[0].body as {
      prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    };
    const noiseNode = Object.values(promptBody.prompt).find((n) => n.class_type === 'RandomNoise');
    expect(noiseNode?.inputs.noise_seed).toBe(9999);
  });

  test('patches width/height into EmptySD3LatentImage and ModelSamplingFlux nodes', async () => {
    const { fetch, calls } = comfyuiFlowFetch();

    await comfyui(BASE_URL, { ...BASE_REQ, width: 768, height: 512 }, { fetch, pollIntervalMs: 0 });

    const promptBody = calls[0].body as {
      prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    };
    const latentNode = Object.values(promptBody.prompt).find((n) => n.class_type === 'EmptySD3LatentImage');
    expect(latentNode?.inputs.width).toBe(768);
    expect(latentNode?.inputs.height).toBe(512);

    const samplingNode = Object.values(promptBody.prompt).find((n) => n.class_type === 'ModelSamplingFlux');
    expect(samplingNode?.inputs.width).toBe(768);
    expect(samplingNode?.inputs.height).toBe(512);
  });

  test('patches guidance scale into FluxGuidance node', async () => {
    const { fetch, calls } = comfyuiFlowFetch();

    await comfyui(BASE_URL, { ...BASE_REQ, guidanceScale: 5.0 }, { fetch, pollIntervalMs: 0 });

    const promptBody = calls[0].body as {
      prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    };
    const guidanceNode = Object.values(promptBody.prompt).find((n) => n.class_type === 'FluxGuidance');
    expect(guidanceNode?.inputs.guidance).toBe(5.0);
  });

  test('patches baseModel into the loader node (UnetLoaderGGUF)', async () => {
    const { fetch, calls } = comfyuiFlowFetch();

    await comfyui(BASE_URL, { ...BASE_REQ, baseModel: 'flux1-dev-Q8_0.gguf' }, { fetch, pollIntervalMs: 0 });

    const promptBody = calls[0].body as {
      prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    };
    const loaderNode = Object.values(promptBody.prompt).find((n) => n.class_type === 'UnetLoaderGGUF');
    expect(loaderNode?.inputs.unet_name).toBe('flux1-dev-Q8_0.gguf');
  });

  test('patches steps into BasicScheduler node', async () => {
    const { fetch, calls } = comfyuiFlowFetch();

    await comfyui(BASE_URL, { ...BASE_REQ, steps: 28 }, { fetch, pollIntervalMs: 0 });

    const promptBody = calls[0].body as {
      prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    };
    const schedulerNode = Object.values(promptBody.prompt).find((n) => n.class_type === 'BasicScheduler');
    expect(schedulerNode?.inputs.steps).toBe(28);
  });

  test('returns the seed used when seed >= 0', async () => {
    const { fetch } = comfyuiFlowFetch();

    const result = await comfyui(BASE_URL, { ...BASE_REQ, seed: 12345 }, { fetch, pollIntervalMs: 0 });
    expect(result.seed).toBe(12345);
  });

  test('returns undefined seed when seed is -1 (random)', async () => {
    const { fetch } = comfyuiFlowFetch();

    const result = await comfyui(BASE_URL, { ...BASE_REQ, seed: -1 }, { fetch, pollIntervalMs: 0 });
    expect(result.seed).toBeUndefined();
  });

  test('encodes filename + subfolder correctly in the /view URL', async () => {
    const { fetch, calls } = comfyuiFlowFetch({
      filename: 'my image 01.png',
      subfolder: 'my folder',
    });

    await comfyui(BASE_URL, BASE_REQ, { fetch, pollIntervalMs: 0 });

    const viewCall = calls.find((c) => c.url.includes('/view'));
    expect(viewCall?.url).toContain('filename=my%20image%2001.png');
    expect(viewCall?.url).toContain('subfolder=my%20folder');
  });
});

// ── Tests: failure handling ───────────────────────────────────────────────────

describe('comfyui failure handling', () => {
  test('a refused connection becomes DiffusionOfflineError', async () => {
    const { DiffusionOfflineError } = await import('./diffusion');
    const fetchStub = (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(comfyui(BASE_URL, BASE_REQ, { fetch: fetchStub })).rejects.toBeInstanceOf(DiffusionOfflineError);
  });

  test('a timed-out request becomes DiffusionTimeoutError', async () => {
    const { DiffusionTimeoutError } = await import('./diffusion');
    const fetchStub = (async () => {
      const e = new Error('The operation timed out.');
      e.name = 'TimeoutError';
      throw e;
    }) as unknown as typeof fetch;

    await expect(comfyui(BASE_URL, BASE_REQ, { fetch: fetchStub })).rejects.toBeInstanceOf(DiffusionTimeoutError);
  });

  test('a non-OK /prompt response throws with the status code', async () => {
    const fetchStub = (async () => new Response('internal server error', { status: 500 })) as unknown as typeof fetch;

    await expect(comfyui(BASE_URL, BASE_REQ, { fetch: fetchStub })).rejects.toThrow('500');
  });

  test('throws DiffusionTimeoutError when max polls are exhausted', async () => {
    // Always returns empty history.
    const { DiffusionTimeoutError } = await import('./diffusion');
    let callCount = 0;
    const fetchStub = (async (url: string, init?: RequestInit) => {
      callCount++;
      if ((url as string).endsWith('/prompt')) {
        return new Response(JSON.stringify({ prompt_id: 'x', number: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 }); // always empty
    }) as unknown as typeof fetch;

    // To avoid running 90 real polls in a test, we use an AbortSignal that fires
    // after the first history response (simulating the adapter seeing an already-
    // aborted signal on the second tick).
    const controller = new AbortController();
    let histCalls = 0;
    const wrappedFetch = (async (url: string, init?: RequestInit) => {
      const res = await fetchStub(url, init);
      if ((url as string).includes('/history/')) {
        histCalls++;
        if (histCalls >= 2) controller.abort();
      }
      return res;
    }) as unknown as typeof fetch;

    await expect(
      comfyui(BASE_URL, BASE_REQ, { fetch: wrappedFetch, signal: controller.signal }),
    ).rejects.toBeInstanceOf(DiffusionTimeoutError);
  });
});

// ── Tests: model discovery ────────────────────────────────────────────────────

describe('listComfyuiModels', () => {
  test('returns the model list from GET /object_info/UnetLoaderGGUF', async () => {
    const models = ['flux1-schnell-Q8_0.gguf', 'flux1-dev-Q8_0.gguf', 'some-other-model.gguf'];
    const fetchStub = (async () =>
      new Response(
        JSON.stringify({
          UnetLoaderGGUF: {
            input: {
              required: {
                unet_name: [models, { tooltip: 'The name of the unet model to load.' }],
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const result = await listComfyuiModels(BASE_URL, { fetch: fetchStub });
    expect(result).toEqual(models);
  });

  test('calls /object_info with the correct loader node type from the template', async () => {
    const calls: string[] = [];
    const fetchStub = (async (url: string) => {
      calls.push(url as string);
      return new Response(
        JSON.stringify({
          UnetLoaderGGUF: {
            input: { required: { unet_name: [['some.gguf']] } },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await listComfyuiModels(BASE_URL, { fetch: fetchStub });
    expect(calls[0]).toContain('/object_info/UnetLoaderGGUF');
  });

  test('returns [] when the server is unreachable (never throws)', async () => {
    const fetchStub = (async () => {
      throw new TypeError('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await listComfyuiModels(BASE_URL, { fetch: fetchStub });
    expect(result).toEqual([]);
  });

  test('returns [] on a non-OK HTTP response (never throws)', async () => {
    const fetchStub = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;

    const result = await listComfyuiModels(BASE_URL, { fetch: fetchStub });
    expect(result).toEqual([]);
  });

  test('returns [] when the node type is not in the response', async () => {
    const fetchStub = (async () =>
      new Response(JSON.stringify({ OtherNodeType: {} }), { status: 200 })) as unknown as typeof fetch;

    const result = await listComfyuiModels(BASE_URL, { fetch: fetchStub });
    expect(result).toEqual([]);
  });

  test('filters out non-string entries from the model enum', async () => {
    const fetchStub = (async () =>
      new Response(
        JSON.stringify({
          UnetLoaderGGUF: {
            input: {
              required: {
                unet_name: [['valid.gguf', 42, null, 'also-valid.gguf'], {}],
              },
            },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await listComfyuiModels(BASE_URL, { fetch: fetchStub });
    expect(result).toEqual(['valid.gguf', 'also-valid.gguf']);
  });
});
