/**
 * Integration: POST /api/open opens an arbitrary file/dir in the configured
 * editor (the `gotab`/openInEditor mechanism, for any path). The seed sets
 * editor:"echo", so "opening" just spawns echo — harmless. Covers the three
 * path forms the UI sends (absolute, ~-prefixed, output-dir-relative) and the
 * bad-input guards.
 */

import { describe, expect, test } from 'bun:test';
import { apiPost, useHarness } from '../index';

useHarness();

describe('POST /api/open', () => {
  test('opens an absolute path, echoing back the editor + resolved path', async () => {
    const res = await apiPost('/api/open', { path: '/tmp/example.txt' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { editor: string; path: string };
    expect(body.editor).toBe('echo'); // seeded editor
    expect(body.path).toBe('/tmp/example.txt');
  });

  test('expands a leading ~ to an absolute home path', async () => {
    const res = await apiPost('/api/open', { path: '~/notes.md' });
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path.startsWith('~')).toBe(false);
    expect(path.startsWith('/')).toBe(true);
    expect(path.endsWith('/notes.md')).toBe(true);
  });

  test('resolves a relative path against the output dir', async () => {
    const res = await apiPost('/api/open', { path: 'report.txt' });
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path.startsWith('/')).toBe(true);
    expect(path.endsWith('/outputs/report.txt')).toBe(true);
  });

  test('rejects a missing or blank path with 400', async () => {
    expect((await apiPost('/api/open', {})).status).toBe(400);
    expect((await apiPost('/api/open', { path: '   ' })).status).toBe(400);
  });
});
