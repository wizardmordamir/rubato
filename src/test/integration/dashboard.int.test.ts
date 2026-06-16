/**
 * Integration: the Dashboard aggregation through `route()` against the seeded
 * test registry (real scaffolded git repos "app" + "billing"). Verifies the
 * git-only facts and the summary roll-up, plus tagging a commit across a subset
 * of apps (and that listTags then reflects it via a fresh dashboard fetch).
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import type { DashboardData, TagAppResult, TagSearchResponse } from '../../shared/dashboard';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

// Give a scaffolded repo (git init, no commits) an initial commit so HEAD
// resolves — real cloned apps always have one; the fixture doesn't.
const commitInitial = (dir: string) => {
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  g('config', 'user.email', 't@t.io');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  g('add', '-A');
  g('commit', '-q', '-m', 'initial', '--allow-empty');
};

describe('dashboard', () => {
  test('aggregates git facts + a summary for the registered apps', async () => {
    const data = (await (await apiGet('/api/dashboard')).json()) as DashboardData;
    expect(data.generatedAt).toBeGreaterThan(0);

    const names = data.rows.map((r) => r.app);
    expect(names).toContain('app');
    expect(names).toContain('billing');

    const app = data.rows.find((r) => r.app === 'app');
    expect(app?.git?.isRepo).toBe(true);
    expect(app?.git?.branch).toBeTruthy(); // scaffolded repo has a checked-out branch
    expect(typeof app?.git?.dirtyCount).toBe('number');
    expect(Array.isArray(app?.git?.localOnlyBranches)).toBe(true);

    // Summary roll-up is internally consistent.
    expect(data.summary.total).toBe(data.rows.length);
    expect(data.summary.repos).toBeGreaterThanOrEqual(2);
    expect(data.summary.repos).toBeLessThanOrEqual(data.summary.total);

    // Default board carries no deploy info (it's opt-in).
    expect(data.deployConfigured).toBeUndefined();
    expect(data.rows.every((r) => r.deploy === undefined)).toBe(true);
  });

  test('?deploy=1 resolves deploy info (the harness has fake creds) without erroring the board', async () => {
    const res = await apiGet('/api/dashboard?deploy=1');
    expect(res.status).toBe(200);
    const data = (await res.json()) as DashboardData;
    // The harness seeds fake JENKINS_*/QUAY_* creds, so a client builds → configured.
    expect(data.deployConfigured).toBe(true);
    // Every app gets a deploy cell (best-effort: present/available or a soft error,
    // never a thrown request). The no-creds → configured:false path is unit-tested.
    expect(data.rows.length).toBeGreaterThanOrEqual(2);
    expect(data.rows.every((r) => r.deploy !== undefined && typeof r.deploy.available === 'boolean')).toBe(true);
  });

  test('tags a commit across a subset of apps; the tag then shows up', async () => {
    // The scaffolded repos start without commits; give them one so HEAD resolves.
    const before = (await (await apiGet('/api/dashboard')).json()) as DashboardData;
    for (const name of ['app', 'billing']) {
      const row = before.rows.find((r) => r.app === name);
      if (row) commitInitial(row.path);
    }

    const res = await (await apiPost('/api/dashboard/tag', { apps: ['app', 'billing'], tag: 'dash-test-1' })).json();
    const results = res.results as TagAppResult[];
    expect(results.every((r) => r.ok)).toBe(true);

    const data = (await (await apiGet('/api/dashboard')).json()) as DashboardData;
    const app = data.rows.find((r) => r.app === 'app');
    expect(app?.git?.tagCount).toBeGreaterThanOrEqual(1);
    expect(app?.git?.recentTags.map((t) => t.name)).toContain('dash-test-1');
  });

  test('ref:"latest" tags each app\'s latest commit (HEAD)', async () => {
    const before = (await (await apiGet('/api/dashboard')).json()) as DashboardData;
    const row = before.rows.find((r) => r.app === 'app');
    if (row) commitInitial(row.path);

    const res = await (
      await apiPost('/api/dashboard/tag', { apps: ['app'], tag: 'latest-test', ref: 'latest' })
    ).json();
    expect((res.results as TagAppResult[]).every((r) => r.ok)).toBe(true);

    const data = (await (await apiGet('/api/dashboard')).json()) as DashboardData;
    expect(data.rows.find((r) => r.app === 'app')?.git?.recentTags.map((t) => t.name)).toContain('latest-test');
  });

  test('reports commits ahead of the base branch + a branch-created date on a feature branch', async () => {
    const before = (await (await apiGet('/api/dashboard')).json()) as DashboardData;
    const dir = before.rows.find((r) => r.app === 'app')?.path;
    expect(dir).toBeTruthy();
    const g = (...args: string[]) => execFileSync('git', ['-C', dir as string, ...args], { stdio: 'pipe' });
    g('config', 'user.email', 't@t.io');
    g('config', 'user.name', 'T');
    g('config', 'commit.gpgsign', 'false');
    g('commit', '-q', '-m', 'base', '--allow-empty');
    g('branch', '-M', 'main'); // make the default branch resolvable as "main"
    g('checkout', '-q', '-b', 'feature/x');
    g('commit', '-q', '-m', 'feature work', '--allow-empty');

    const data = (await (await apiGet('/api/dashboard')).json()) as DashboardData;
    const app = data.rows.find((r) => r.app === 'app');
    expect(app?.git?.branch).toBe('feature/x');
    expect(app?.git?.aheadOfBase).toBe(1); // one commit beyond main
    expect(app?.git?.behindBase).toBe(0);
    expect(app?.git?.branchCreatedAt).toMatch(/^\d{4}-\d\d-\d\dT/); // ISO date set
  });

  test('tag search finds apps whose tags match a name prefix', async () => {
    const before = (await (await apiGet('/api/dashboard')).json()) as DashboardData;
    const row = before.rows.find((r) => r.app === 'app');
    if (row) commitInitial(row.path);
    await apiPost('/api/dashboard/tag', { apps: ['app'], tag: 'v9.9.9' });

    const hit = (await (await apiGet('/api/dashboard/tags?prefix=v9')).json()) as TagSearchResponse;
    expect(hit.prefix).toBe('v9');
    expect(hit.results.find((r) => r.app === 'app')?.tags.map((t) => t.name)).toContain('v9.9.9');

    // A prefix that matches nothing yields no app entries.
    const none = (await (await apiGet('/api/dashboard/tags?prefix=zzz-nomatch')).json()) as TagSearchResponse;
    expect(none.results).toEqual([]);
  });

  test('validates the tag request and reports unknown apps', async () => {
    expect((await apiPost('/api/dashboard/tag', { apps: [], tag: 'x' })).status).toBe(400);
    expect((await apiPost('/api/dashboard/tag', { apps: ['app'], tag: '' })).status).toBe(400);

    const res = await (await apiPost('/api/dashboard/tag', { apps: ['does-not-exist'], tag: 'y' })).json();
    const results = res.results as TagAppResult[];
    expect(results[0]).toMatchObject({ app: 'does-not-exist', ok: false });
  });
});
