import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { appAssetsDir, generateArt, listAssets, sanitizeAppId } from './generateImage';

const PNG_B64 = Buffer.from('img-bytes').toString('base64');

/** Fooocus-shaped fetch stub (the default backend) returning one base64 image. */
const fooocusFetch = (async () =>
  new Response(JSON.stringify([{ base64: PNG_B64 }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

describe('sanitizeAppId', () => {
  test('strips path-traversal + unsafe chars, falls back to __global', () => {
    expect(sanitizeAppId('../../etc/passwd')).not.toContain('/');
    expect(sanitizeAppId('../../etc')).not.toContain('..');
    expect(sanitizeAppId('')).toBe('__global');
    expect(sanitizeAppId(undefined)).toBe('__global');
    expect(sanitizeAppId('my-app_1')).toBe('my-app_1');
  });
});

describe('generateArt', () => {
  test('enriches, writes a PNG, applies default quality styles, and records the ledger', async () => {
    // RUBATO_HOME is isolated to a temp dir by the test preload, so this writes there.
    const result = await generateArt(
      { appId: 'demo-app', prompt: 'a gear icon', preset: 'app_icon', width: 1024, height: 1024 },
      { fetch: fooocusFetch },
    );

    expect(result.success).toBe(true);
    expect(result.appId).toBe('demo-app');
    expect(result.url).toBe(`/api/generated-assets/demo-app/${result.fileName}`);
    expect(result.enrichedPrompt).toContain('a gear icon');
    expect(result.enrichedPrompt).toContain('icon'); // preset modifiers applied
    // Quality defaults flow through to the result.
    expect(result.styles).toContain('Fooocus V2'); // the prompt-expansion engine is always on
    expect(result.performance).toBe('Speed');

    // The bytes actually landed on disk under the app's asset dir.
    expect(result.path.startsWith(appAssetsDir('demo-app'))).toBe(true);
    expect((await readFile(result.path)).toString()).toBe('img-bytes');

    // listAssets joins the on-disk file with its ledger metadata.
    const listed = await listAssets('demo-app');
    const item = listed.find((a) => a.fileName === result.fileName);
    expect(item).toBeDefined();
    expect(item?.meta?.prompt).toBe('a gear icon');
    expect(item?.meta?.preset).toBe('app_icon');
    expect(item?.meta?.styles).toContain('Fooocus V2');
    expect(item?.meta?.width).toBe(1024);
  });

  test('an explicit negative prompt + styles override the preset/config defaults', async () => {
    const result = await generateArt(
      {
        appId: 'demo-app',
        prompt: 'a calm seascape',
        preset: 'raw_creative',
        negativePrompt: 'people, boats',
        styles: ['Fooocus Cinematic'],
      },
      { fetch: fooocusFetch },
    );
    expect(result.negativePrompt).toContain('people, boats');
    expect(result.styles).toContain('Fooocus Cinematic');
    expect(result.styles).toContain('Fooocus V2'); // engine is force-included
  });

  test('listAssets returns [] for an app with no generated assets', async () => {
    expect(await listAssets('never-generated-app')).toEqual([]);
  });
});
