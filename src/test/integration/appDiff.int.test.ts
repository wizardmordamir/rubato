/**
 * Integration: the per-app uncommitted-diff viewer through `route()` — list
 * changes, diff one file, and stash/discard, against a seeded repo.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../lib/apps';
import type { AppDiffSummary } from '../../server/appGit';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

const commitInitial = (dir: string) => {
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  g('config', 'user.email', 't@t.io');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  g('commit', '-q', '-m', 'initial', '--allow-empty');
};

const appDir = async (name: string): Promise<string> => {
  const apps = (await (await apiGet('/api/apps')).json()) as AppConfig[];
  const dir = apps.find((a) => a.name === name)?.absolutePath;
  if (!dir) throw new Error(`seed missing ${name}`);
  return dir;
};

describe('app diff viewer', () => {
  test('lists changes, diffs a file, discards one + all', async () => {
    const dir = await appDir('app');
    commitInitial(dir);
    // Commit a clean baseline (the scaffold leaves README/package.json untracked),
    // including a tracked file we'll then modify, plus a new untracked file.
    await writeFile(join(dir, 'tracked.txt'), 'v1\n');
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'baseline'], { stdio: 'pipe' });
    await writeFile(join(dir, 'tracked.txt'), 'v1\nv2\n');
    await writeFile(join(dir, 'fresh.txt'), 'new\n');

    const list = (await (await apiGet('/api/apps/app/diff')).json()) as AppDiffSummary;
    expect(list.ok).toBe(true);
    const paths = list.files.map((f) => f.path).sort();
    expect(paths).toEqual(['fresh.txt', 'tracked.txt']);
    expect(list.files.find((f) => f.path === 'fresh.txt')?.untracked).toBe(true);

    // Diff the untracked file (all additions).
    const fd = (await (await apiGet('/api/apps/app/diff?path=fresh.txt&untracked=1')).json()) as { diff: string };
    expect(fd.diff).toContain('+new');

    // Drop just the tracked edit; the untracked file remains.
    const afterDrop = (await (
      await apiPost('/api/apps/app/diff', { action: 'discard', paths: ['tracked.txt'] })
    ).json()) as AppDiffSummary;
    expect(afterDrop.files.map((f) => f.path)).toEqual(['fresh.txt']);

    // Discard everything → clean.
    const afterAll = (await (await apiPost('/api/apps/app/diff', { action: 'discardAll' })).json()) as AppDiffSummary;
    expect(afterAll.files).toEqual([]);
  });

  test('bad action → 400, unknown app → 404', async () => {
    expect((await apiPost('/api/apps/app/diff', { action: 'nope' })).status).toBe(400);
    expect((await apiPost('/api/apps/__no_such_app__/diff', { action: 'stash' })).status).toBe(404);
  });
});
