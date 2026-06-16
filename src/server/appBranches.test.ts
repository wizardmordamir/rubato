import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../lib/apps';
import { git } from '../lib/git';
import { getAppBranches, runAppBranchAction } from './appBranches';
import { runAppDiffAction } from './appGit';

const asApp = (dir: string): AppConfig => ({ absolutePath: dir, name: 'x' }) as AppConfig;

async function repoOnMain(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rubato-br-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@t.test']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

describe('branch management (real repo)', () => {
  test('list, create+switch, checkout, delete; current branch is protected from delete', async () => {
    const app = asApp(await repoOnMain());

    expect((await getAppBranches(app)).current).toBe('main');

    expect((await runAppBranchAction(app, { action: 'create', name: 'feature' })).ok).toBe(true);
    let listed = await getAppBranches(app);
    expect(listed.current).toBe('feature'); // create switches to it
    expect(listed.branches.map((b) => b.name).sort()).toEqual(['feature', 'main']);

    // Can't delete the branch you're on.
    expect((await runAppBranchAction(app, { action: 'delete', name: 'feature' })).ok).toBe(false);

    expect((await runAppBranchAction(app, { action: 'checkout', name: 'main' })).ok).toBe(true);
    const del = await runAppBranchAction(app, { action: 'delete', name: 'feature' });
    expect(del.ok).toBe(true);
    expect(del.removed).toEqual(['feature']);
    listed = await getAppBranches(app);
    expect(listed.branches.map((b) => b.name)).toEqual(['main']);

    // Bad names are rejected before reaching git.
    expect((await runAppBranchAction(app, { action: 'checkout', name: '-rf' })).ok).toBe(false);
  });
});

describe('commit selected files (runAppDiffAction commit)', () => {
  test('stages + commits ONLY the chosen path, leaving the rest changed', async () => {
    const app = asApp(await repoOnMain());
    await writeFile(join(app.absolutePath, 'a.txt'), 'one\nedited\n'); // modify tracked
    await writeFile(join(app.absolutePath, 'b.txt'), 'new\n'); // add untracked

    const res = await runAppDiffAction(app, 'commit', ['a.txt'], 'commit just a');
    expect(res.ok).toBe(true);
    // a.txt is committed (gone from the change list); b.txt remains untracked.
    expect(res.files.map((f) => f.path)).toEqual(['b.txt']);

    const log = await git(app.absolutePath, ['log', '--format=%s', '-1']);
    expect(log.stdout.trim()).toBe('commit just a');

    // Guard rails: no paths / no message → error, nothing committed.
    expect((await runAppDiffAction(app, 'commit', [], 'x')).ok).toBe(false);
    expect((await runAppDiffAction(app, 'commit', ['b.txt'], '')).ok).toBe(false);
  });
});
