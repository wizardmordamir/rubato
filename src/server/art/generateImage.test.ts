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
  test('enriches, writes a PNG under the app dir, and lists it', async () => {
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

    // The bytes actually landed on disk under the app's asset dir.
    expect(result.path.startsWith(appAssetsDir('demo-app'))).toBe(true);
    expect((await readFile(result.path)).toString()).toBe('img-bytes');

    const listed = await listAssets('demo-app');
    expect(listed.some((a) => a.fileName === result.fileName)).toBe(true);
  });

  test('listAssets returns [] for an app with no generated assets', async () => {
    expect(await listAssets('never-generated-app')).toEqual([]);
  });
});
