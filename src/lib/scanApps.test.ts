import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepos } from './scanApps';

let tmp = '';

async function makeTmp(): Promise<string> {
  const dir = join(tmpdir(), `rubato-scan-${Math.floor(Math.random() * 1e9)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function makeRepo(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(join(dir, '.git'), { recursive: true });
  return dir;
}

async function makeWorktree(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.git'), 'gitdir: /some/repo/.git/worktrees/name');
  return dir;
}

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = '';
});

describe('findRepos', () => {
  test('includes real repos (.git is a directory)', async () => {
    tmp = await makeTmp();
    const repoPath = await makeRepo(tmp, 'myapp');
    const repos = await findRepos(tmp, new Set());
    expect(repos).toContain(repoPath);
  });

  test('skips linked worktrees (.git is a file)', async () => {
    tmp = await makeTmp();
    const worktreePath = await makeWorktree(tmp, 'myapp-feature');
    const repos = await findRepos(tmp, new Set());
    expect(repos).not.toContain(worktreePath);
  });

  test('skips *-integration sibling dirs (integration worktrees placed beside their repo)', async () => {
    tmp = await makeTmp();
    const repoPath = await makeRepo(tmp, 'rubato');
    const integrationPath = await makeWorktree(tmp, 'rubato-integration');
    const repos = await findRepos(tmp, new Set());
    expect(repos).toContain(repoPath);
    expect(repos).not.toContain(integrationPath);
  });

  test('skips all four *-integration dirs that mirror the multi-app layout', async () => {
    tmp = await makeTmp();
    const expected = await Promise.all([
      makeRepo(tmp, 'cwip'),
      makeRepo(tmp, 'cursedbelt'),
      makeRepo(tmp, 'cursedalchemy'),
      makeRepo(tmp, 'rubato'),
    ]);
    const excluded = await Promise.all([
      makeWorktree(tmp, 'cwip-integration'),
      makeWorktree(tmp, 'cursedbelt-integration'),
      makeWorktree(tmp, 'cursedalchemy-integration'),
      makeWorktree(tmp, 'rubato-integration'),
    ]);
    const repos = await findRepos(tmp, new Set());
    for (const p of expected) expect(repos).toContain(p);
    for (const p of excluded) expect(repos).not.toContain(p);
  });

  test('skips *-worktrees directories', async () => {
    tmp = await makeTmp();
    const repoPath = await makeRepo(tmp, 'rubato');
    const worktreesDir = join(tmp, 'rubato-worktrees');
    await mkdir(worktreesDir);
    const featureDir = await makeWorktree(worktreesDir, 'feat-foo');
    const repos = await findRepos(tmp, new Set());
    expect(repos).toContain(repoPath);
    expect(repos).not.toContain(featureDir);
  });

  test('does not descend into ignored directories', async () => {
    tmp = await makeTmp();
    const ignoredDir = join(tmp, 'vendor-stuff');
    await mkdir(ignoredDir);
    const hiddenRepo = await makeRepo(ignoredDir, 'inner');
    const repos = await findRepos(tmp, new Set(['vendor-stuff']));
    expect(repos).not.toContain(hiddenRepo);
  });
});
