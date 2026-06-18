import { describe, expect, test } from 'bun:test';
import { DiffusionOfflineError, type DiffusionRequest, generateImageBuffer } from './diffusion';

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
    const buf = await generateImageBuffer('a1111', 'http://localhost:7860', req, { fetch });
    expect(buf.toString()).toBe('fake-png-bytes');
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
});

describe('fooocus adapter', () => {
  test('posts to /v2/generation/text-to-image with aspect ratio + base64 flag', async () => {
    const { fetch, calls } = jsonFetch([{ base64: PNG_B64 }]);
    const buf = await generateImageBuffer('fooocus', 'http://localhost:8888/', req, { fetch });
    expect(buf.toString()).toBe('fake-png-bytes');
    expect(calls[0].url).toBe('http://localhost:8888/v2/generation/text-to-image');
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.aspect_ratios_selection).toBe('1216*832');
    expect(sent.require_base64).toBe(true);
  });

  test('strips a data-URL header from the returned base64', async () => {
    const { fetch } = jsonFetch([{ base64: `data:image/png;base64,${PNG_B64}` }]);
    const buf = await generateImageBuffer('fooocus', 'http://localhost:8888', req, { fetch });
    expect(buf.toString()).toBe('fake-png-bytes');
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

  test('a non-OK HTTP response throws with the status', async () => {
    const fetchStub = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(generateImageBuffer('a1111', 'http://x', req, { fetch: fetchStub })).rejects.toThrow('500');
  });

  test('comfyui is not wired and throws an actionable error', async () => {
    await expect(generateImageBuffer('comfyui', 'http://localhost:8188', req)).rejects.toThrow('not wired');
  });
});
