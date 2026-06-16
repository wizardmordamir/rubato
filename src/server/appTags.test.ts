import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../lib/apps';
import { git } from '../lib/git';
import { createAppTag, getAppTags, parseTagList, runAppTagAction } from './appTags';

const asApp = (dir: string): AppConfig => ({ absolutePath: dir, name: 'x' }) as AppConfig;
const US = '\x1f';

async function repoWithCommit(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rubato-tags-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@t.test']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'initial commit']);
  return dir;
}

describe('parseTagList', () => {
  test('reads lightweight vs annotated, dereferencing annotated tags to their commit', () => {
    // fields: name, objecttype, objectname, *objectname, creatordate, contents:subject, subject, *subject
    const text = [
      ['v1', 'commit', 'abc123', '', '2026-06-14T10:00:00-05:00', '', 'commit subject', ''].join(US),
      [
        'v2',
        'tag',
        'tag9999',
        'def456',
        '2026-06-13T10:00:00-05:00',
        'release notes',
        'annotation subj',
        'commit subject',
      ].join(US),
    ].join('\n');
    expect(parseTagList(text)).toEqual([
      {
        name: 'v1',
        commit: 'abc123',
        subject: 'commit subject',
        date: '2026-06-14T10:00:00-05:00',
        annotated: false,
        message: undefined,
      },
      {
        name: 'v2',
        commit: 'def456',
        subject: 'commit subject',
        date: '2026-06-13T10:00:00-05:00',
        annotated: true,
        message: 'release notes',
      },
    ]);
  });
});

describe('tag lifecycle (real repo)', () => {
  test('create lightweight + annotated, list with metadata, checkout, delete', async () => {
    const dir = await repoWithCommit();
    const app = asApp(dir);

    expect((await createAppTag(app, { name: 'v1.0' })).ok).toBe(true);
    expect((await createAppTag(app, { name: 'v2.0', message: 'second release' })).ok).toBe(true);
    // An invalid name is rejected before touching git.
    expect((await createAppTag(app, { name: 'bad name' })).ok).toBe(false);

    const listed = await getAppTags(app);
    expect(listed.ok).toBe(true);
    const byName = Object.fromEntries(listed.tags.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['v1.0', 'v2.0']);
    expect(byName['v1.0'].annotated).toBe(false);
    expect(byName['v2.0'].annotated).toBe(true);
    expect(byName['v2.0'].message).toBe('second release');
    expect(byName['v1.0'].subject).toBe('initial commit'); // target commit subject
    expect(byName['v1.0'].commit).toMatch(/^[0-9a-f]{4,}$/);

    expect((await runAppTagAction(app, 'checkout', 'v1.0')).ok).toBe(true); // detached HEAD at the tag
    expect((await runAppTagAction(app, 'delete', 'v2.0')).ok).toBe(true);
    expect((await getAppTags(app)).tags.map((t) => t.name)).toEqual(['v1.0']);

    // Guarded actions reject bad names.
    expect((await runAppTagAction(app, 'delete', '-rf')).ok).toBe(false);
  });
});
