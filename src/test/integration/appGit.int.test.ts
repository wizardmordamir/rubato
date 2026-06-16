/**
 * Integration: per-app git quick-actions through `route()` against the seeded
 * test registry (real scaffolded repos). Commit-all + checkout-default work
 * locally (no remote); bad action → 400, unknown app → 404.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../lib/apps';
import type { AppGitResult } from '../../server/appGit';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

// Scaffolded repos start without commits; give them one so HEAD resolves.
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
  if (!dir) throw new Error(`seed missing app ${name}`);
  return dir;
};

describe('app git actions', () => {
  test('commitAll commits the working tree; bad action → 400; unknown app → 404', async () => {
    const dir = await appDir('app');
    commitInitial(dir);
    await writeFile(join(dir, 'change.txt'), 'x');

    const res = (await (
      await apiPost('/api/apps/app/git', { action: 'commitAll', message: 'test wip' })
    ).json()) as AppGitResult;
    expect(res.ok).toBe(true);
    expect(res.action).toBe('commitAll');
    expect(typeof res.branch).toBe('string');

    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(status.trim()).toBe(''); // tree is clean after commit-all

    expect((await apiPost('/api/apps/app/git', { action: 'nope' })).status).toBe(400);
    expect((await apiPost('/api/apps/__no_such_app__/git', { action: 'pull' })).status).toBe(404);
  });

  test('checkoutDefault reports the default branch', async () => {
    const dir = await appDir('billing');
    commitInitial(dir);
    const res = (await (await apiPost('/api/apps/billing/git', { action: 'checkoutDefault' })).json()) as AppGitResult;
    expect(res.ok).toBe(true);
    expect(res.branch).toBeTruthy();
  });
});
