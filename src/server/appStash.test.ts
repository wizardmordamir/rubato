import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../lib/apps';
import { git } from '../lib/git';
import { getAppStashes, getAppStashFiles, parseStashList, runAppStashAction } from './appStash';

const asApp = (dir: string): AppConfig => ({ absolutePath: dir, name: 'x' }) as AppConfig;

/** A fresh git repo with one committed file. */
async function repoWith(file: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rubato-stash-'));
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 't@t.test']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, file), content);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

const US = '\x1f';

describe('parseStashList', () => {
  test('parses NUL-terminated, US-separated entries; skips junk', () => {
    const text = [
      ['stash@{0}', 'WIP on main: abc fix', '2 hours ago', '2026-06-14T10:00:00-05:00'].join(US),
      ['stash@{1}', 'On main: wip', '3 days ago', '2026-06-11T10:00:00-05:00'].join(US),
      'not-a-stash-line',
    ].join('\0');
    expect(parseStashList(text)).toEqual([
      {
        ref: 'stash@{0}',
        index: 0,
        message: 'WIP on main: abc fix',
        relativeDate: '2 hours ago',
        date: '2026-06-14T10:00:00-05:00',
      },
      {
        ref: 'stash@{1}',
        index: 1,
        message: 'On main: wip',
        relativeDate: '3 days ago',
        date: '2026-06-11T10:00:00-05:00',
      },
    ]);
  });

  test('empty input → no entries', () => {
    expect(parseStashList('')).toEqual([]);
  });
});

describe('stash lifecycle (real repo)', () => {
  test('list, inspect files, drop, clear', async () => {
    const dir = await repoWith('a.txt', 'one\n');
    const app = asApp(dir);

    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
    await git(dir, ['stash', 'push', '-m', 'first']);

    const listed = await getAppStashes(app);
    expect(listed.ok).toBe(true);
    expect(listed.stashes).toHaveLength(1);
    expect(listed.stashes[0].ref).toBe('stash@{0}');

    // The stash's own changes: a.txt is modified.
    const files = await getAppStashFiles(app, 'stash@{0}', 'stash');
    expect(files.ok).toBe(true);
    expect(files.files.map((f) => f.path)).toEqual(['a.txt']);

    // A bad ref is rejected (these are passed as git args).
    expect((await getAppStashFiles(app, 'stash@{0}; rm -rf /', 'stash')).ok).toBe(false);

    expect((await runAppStashAction(app, { action: 'drop', ref: 'stash@{0}' })).ok).toBe(true);
    expect((await getAppStashes(app)).stashes).toHaveLength(0);

    // clear is a no-op-safe even with nothing to clear
    expect((await runAppStashAction(app, { action: 'clear' })).ok).toBe(true);
  });

  test('apply conflict surfaces conflicted files + undoToken, and undo restores the pre-apply tree', async () => {
    const dir = await repoWith('a.txt', 'base\n');
    const app = asApp(dir);
    await writeFile(join(dir, 'b.txt'), 'b-base\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', 'add b']);

    // Stash a change to a.txt …
    await writeFile(join(dir, 'a.txt'), 'from-stash\n');
    await git(dir, ['stash', 'push', '-m', 'stashed']);
    // … then COMMIT a divergent change to the same line (a stash apply conflicts
    // against committed history; it would merely refuse against a dirty file).
    await writeFile(join(dir, 'a.txt'), 'from-commit\n');
    await git(dir, ['commit', '-qa', '-m', 'diverge a']);
    // … plus an unrelated *uncommitted* edit, so the pre-apply snapshot is non-empty.
    await writeFile(join(dir, 'b.txt'), 'b-dirty\n');

    const applied = await runAppStashAction(app, { action: 'apply', ref: 'stash@{0}' });
    expect(applied.ok).toBe(true);
    expect(applied.conflicted).toBe(true);
    expect(applied.conflictedFiles).toEqual(['a.txt']);
    expect(typeof applied.undoToken).toBe('string'); // dirty b.txt → snapshot exists
    expect(await Bun.file(join(dir, 'a.txt')).text()).toContain('<<<<<<<'); // conflict markers
    expect((await getAppStashes(app)).stashes).toHaveLength(1); // stash preserved on conflict

    const undone = await runAppStashAction(app, { action: 'undo', undoToken: applied.undoToken });
    expect(undone.ok).toBe(true);
    expect(await Bun.file(join(dir, 'a.txt')).text()).toBe('from-commit\n'); // resolved-away
    expect(await Bun.file(join(dir, 'b.txt')).text()).toBe('b-dirty\n'); // pre-apply WIP restored
    expect((await getAppStashes(app)).stashes).toHaveLength(1); // stash still there for later
  });

  test('pop on a clean apply drops the stash', async () => {
    const dir = await repoWith('a.txt', 'base\n');
    const app = asApp(dir);
    await writeFile(join(dir, 'b.txt'), 'new file\n'); // a non-conflicting change
    await git(dir, ['stash', 'push', '--include-untracked', '-m', 'stashed']);

    const popped = await runAppStashAction(app, { action: 'pop', ref: 'stash@{0}' });
    expect(popped.ok).toBe(true);
    expect(popped.conflicted).toBeFalsy();
    expect(popped.popped).toBe(true);
    expect((await getAppStashes(app)).stashes).toHaveLength(0); // dropped
    expect(await Bun.file(join(dir, 'b.txt')).text()).toBe('new file\n'); // restored
  });
});
