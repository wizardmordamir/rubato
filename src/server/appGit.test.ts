import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../lib/apps';
import { git } from '../lib/git';
import { getAppDiff, getAppFileDiff, getAppFullDiff, parseDiffNameStatus } from './appGit';

const asApp = (dir: string): AppConfig => ({ absolutePath: dir, name: 'x' }) as AppConfig;

describe('parseDiffNameStatus', () => {
  test('maps M/A/D/R codes and keeps the new path on a rename', () => {
    const text = ['M\tsrc/a.ts', 'A\tsrc/b.ts', 'D\tsrc/c.ts', 'R100\tsrc/old.ts\tsrc/new.ts'].join('\n');
    expect(parseDiffNameStatus(text)).toEqual([
      { path: 'src/a.ts', status: 'modified', untracked: false },
      { path: 'src/b.ts', status: 'added', untracked: false },
      { path: 'src/c.ts', status: 'deleted', untracked: false },
      { path: 'src/new.ts', status: 'renamed', untracked: false },
    ]);
  });
});

describe('multi-base diff (real repo)', () => {
  test('head = uncommitted; main = everything the branch differs from main by', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-diff-'));
    await git(dir, ['init', '-q', '-b', 'main']);
    await git(dir, ['config', 'user.email', 't@t.test']);
    await git(dir, ['config', 'user.name', 'Test']);
    await writeFile(join(dir, 'base.txt'), 'base\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', 'base']);

    // A committed change on a feature branch …
    await git(dir, ['checkout', '-q', '-b', 'feature']);
    await writeFile(join(dir, 'feat.txt'), 'feature\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', 'add feat']);
    // … plus an uncommitted edit.
    await writeFile(join(dir, 'base.txt'), 'base edited\n');

    const app = asApp(dir);

    // head: only the uncommitted edit to base.txt.
    const head = await getAppDiff(app, 'head');
    expect(head.ok).toBe(true);
    expect(head.base).toBe('head');
    expect(head.files.map((f) => f.path).sort()).toEqual(['base.txt']);

    // vs main: the branch's committed feat.txt AND the uncommitted base.txt edit.
    const vsMain = await getAppDiff(app, 'main');
    expect(vsMain.ok).toBe(true);
    expect(vsMain.baseRef).toBe('main');
    expect(vsMain.files.map((f) => f.path).sort()).toEqual(['base.txt', 'feat.txt']);

    // A per-file diff vs main shows feat.txt as added.
    const fileDiff = await getAppFileDiff(app, 'feat.txt', false, 'main');
    expect(fileDiff.diff).toContain('+feature');

    // The combined diff vs main covers both files.
    const full = await getAppFullDiff(app, 'main');
    expect(full.diff).toContain('feat.txt');
    expect(full.diff).toContain('base.txt');
  });
});
