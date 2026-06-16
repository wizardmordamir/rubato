/**
 * Integration: clone-to-location + git config-fill through `route()`. Both run
 * offline against the seeded repos / a local source repo — no network or creds.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../lib/apps';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

const appByName = async (name: string) =>
  ((await (await apiGet('/api/apps')).json()) as AppConfig[]).find((a) => a.name === name);

describe('clone-to-location', () => {
  test('clones a local source repo into a fresh dest and registers it', async () => {
    // A real source repo to clone from (local path acts as the 'url').
    const src = await mkdtemp(join(tmpdir(), 'rubato-src-'));
    const parent = await mkdtemp(join(tmpdir(), 'rubato-dest-'));
    const dest = join(parent, 'cloned-app');
    const g = (...a: string[]) => execFileSync('git', ['-C', src, ...a], { stdio: 'pipe' });
    try {
      g('init', '-q');
      g('config', 'user.email', 't@t.io');
      g('config', 'user.name', 'T');
      g('config', 'commit.gpgsign', 'false');
      g('commit', '-q', '-m', 'init', '--allow-empty');

      const res = await apiPost('/api/apps/clone', { url: src, dest, name: 'cloned-app' });
      expect(res.status).toBe(200);
      const app = (await res.json()) as AppConfig;
      expect(app.name).toBe('cloned-app');
      expect(app.cloneUrl).toBe(src);
      // It's in the registry now.
      expect(await appByName('cloned-app')).toBeTruthy();

      // Cloning onto the now-existing dest fails cleanly (400, not a crash).
      expect((await apiPost('/api/apps/clone', { url: src, dest })).status).toBe(400);
      // Missing fields → 400.
      expect((await apiPost('/api/apps/clone', { url: src })).status).toBe(400);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('fill-git-urls', () => {
  test("backfills cloneUrl from a repo's origin remote", async () => {
    const app = await appByName('app');
    expect(app?.cloneUrl).toBeFalsy(); // not set yet
    // Give the seeded 'app' repo an origin so there's a URL to derive (set-url if
    // the scaffold already added one).
    const dir = app?.absolutePath ?? '';
    const url = 'https://example.com/app.git';
    try {
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url], { stdio: 'pipe' });
    } catch {
      execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', url], { stdio: 'pipe' });
    }

    const res = (await (await apiPost('/api/apps/fill-git-urls', {})).json()) as {
      filled: Array<{ name: string; cloneUrl: string }>;
      count: number;
    };
    expect(res.filled.find((f) => f.name === 'app')?.cloneUrl).toBe('https://example.com/app.git');
    expect((await appByName('app'))?.cloneUrl).toBe('https://example.com/app.git');
  });
});
