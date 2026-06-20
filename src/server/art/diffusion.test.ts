import { describe, expect, test } from 'bun:test';
import { DiffusionOfflineError, type DiffusionRequest, DiffusionTimeoutError, generateImageBuffer } from './diffusion';

const req: DiffusionRequest = {
  prompt: 'a wizard',
  negativePrompt: 'text, blurry',
  width: 1216,
  height: 832,
  steps: 4,
};

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

/** A fetch stub that records the request and returns a fixed JSON body. */
function jsonFetch(body: unknown): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchStub = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: fetchStub, calls };
}

describe('a1111 adapter', () => {
  test('posts to /sdapi/v1/txt2img and decodes images[0]', async () => {
    const { fetch, calls } = jsonFetch({ images: [PNG_B64] });
    const { image } = await generateImageBuffer('a1111', 'http://localhost:7860', req, { fetch });
    expect(image.toString()).toBe('fake-png-bytes');
    expect(calls[0].url).toBe('http://localhost:7860/sdapi/v1/txt2img');
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent).toMatchObject({
      prompt: 'a wizard',
      negative_prompt: 'text, blurry',
      width: 1216,
      height: 832,
      steps: 4,
    });
  });

  test('forwards seed + guidance and parses the seed from info', async () => {
    const { fetch, calls } = jsonFetch({ images: [PNG_B64], info: JSON.stringify({ seed: 4242 }) });
    const { seed } = await generateImageBuffer(
      'a1111',
      'http://x',
      { ...req, seed: 4242, guidanceScale: 6 },
      { fetch },
    );
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.seed).toBe(4242);
    expect(sent.cfg_scale).toBe(6);
    expect(seed).toBe(4242);
  });
});

describe('fooocus adapter', () => {
  test('posts to /v1/generation/text-to-image with aspect ratio + base64 flag', async () => {
    const { fetch, calls } = jsonFetch([{ base64: PNG_B64 }]);
    const { image } = await generateImageBuffer('fooocus', 'http://localhost:8888/', req, { fetch });
    expect(image.toString()).toBe('fake-png-bytes');
    expect(calls[0].url).toBe('http://localhost:8888/v1/generation/text-to-image');
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.aspect_ratios_selection).toBe('1216*832');
    expect(sent.require_base64).toBe(true);
    expect(sent.image_seed).toBe(-1); // random when no seed given
    // Headless engine: previews + intermediate buffers are disabled to save memory.
    expect(sent.advanced_params).toMatchObject({ disable_preview: true, disable_intermediate_results: true });
  });

  test('forwards the refiner override (a memory lever) when provided', async () => {
    const { fetch, calls } = jsonFetch([{ base64: PNG_B64 }]);
    await generateImageBuffer(
      'fooocus',
      'http://localhost:8888',
      { ...req, refinerModel: 'None', refinerSwitch: 0.6 },
      { fetch },
    );
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.refiner_model_name).toBe('None');
    expect(sent.refiner_switch).toBe(0.6);
  });

  test('omits refiner fields when not provided (engine keeps its default)', async () => {
    const { fetch, calls } = jsonFetch([{ base64: PNG_B64 }]);
    await generateImageBuffer('fooocus', 'http://localhost:8888', req, { fetch });
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.refiner_model_name).toBeUndefined();
    expect(sent.refiner_switch).toBeUndefined();
  });

  test('sends the full quality surface (styles, performance, guidance, sharpness, seed)', async () => {
    const { fetch, calls } = jsonFetch([{ base64: PNG_B64, seed: '777' }]);
    const { seed } = await generateImageBuffer(
      'fooocus',
      'http://localhost:8888',
      {
        ...req,
        styles: ['Fooocus V2', 'Fooocus Cinematic'],
        performance: 'Quality',
        guidanceScale: 4.5,
        sharpness: 3,
        seed: 777,
        baseModel: 'juggernautXL_v8Rundiffusion.safetensors',
      },
      { fetch },
    );
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.style_selections).toEqual(['Fooocus V2', 'Fooocus Cinematic']);
    expect(sent.performance_selection).toBe('Quality');
    expect(sent.guidance_scale).toBe(4.5);
    expect(sent.sharpness).toBe(3);
    expect(sent.image_seed).toBe(777);
    expect(sent.base_model_name).toBe('juggernautXL_v8Rundiffusion.safetensors');
    expect(seed).toBe(777); // seed parsed back from the response
  });

  test('strips a data-URL header from the returned base64', async () => {
    const { fetch } = jsonFetch([{ base64: `data:image/png;base64,${PNG_B64}` }]);
    const { image } = await generateImageBuffer('fooocus', 'http://localhost:8888', req, { fetch });
    expect(image.toString()).toBe('fake-png-bytes');
  });

  test('a non-SUCCESS finish_reason throws', async () => {
    const { fetch } = jsonFetch([{ base64: null, finish_reason: 'QUEUE_IS_FULL' }]);
    await expect(generateImageBuffer('fooocus', 'http://localhost:8888', req, { fetch })).rejects.toThrow(
      'QUEUE_IS_FULL',
    );
  });
});

describe('failure handling', () => {
  test('a refused connection becomes a friendly DiffusionOfflineError', async () => {
    const fetchStub = (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch;
    const err = await generateImageBuffer('fooocus', 'http://localhost:8888', req, { fetch: fetchStub }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DiffusionOfflineError);
    expect((err as Error).message).toContain('offline');
    expect((err as Error).message).toContain('8888');
  });

  test('an aborted/timed-out request is a DiffusionTimeoutError, NOT offline', async () => {
    const fetchStub = (async () => {
      // AbortSignal.timeout() rejects with a TimeoutError DOMException.
      const e = new Error('The operation timed out.');
      e.name = 'TimeoutError';
      throw e;
    }) as unknown as typeof fetch;
    const err = await generateImageBuffer('fooocus', 'http://localhost:8888', req, { fetch: fetchStub }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DiffusionTimeoutError);
    expect(err).not.toBeInstanceOf(DiffusionOfflineError);
    expect((err as Error).message).toContain('timed out');
  });

  test('a non-OK HTTP response throws with the status', async () => {
    const fetchStub = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(generateImageBuffer('a1111', 'http://x', req, { fetch: fetchStub })).rejects.toThrow('500');
  });

  test('comfyui is not wired and throws an actionable error', async () => {
    await expect(generateImageBuffer('comfyui', 'http://localhost:8188', req)).rejects.toThrow('not wired');
  });
});
