import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../lib/apps';
import { git } from '../lib/git';
import { getAppCommitFileDiff, getAppCommitFiles, getAppLog, parseLog } from './appLog';

const asApp = (dir: string): AppConfig => ({ absolutePath: dir, name: 'x' }) as AppConfig;
const US = '\x1f';
const RS = '\x1e';

async function repoWithCommits(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rubato-log-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@t.test']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'first']);
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
  await git(dir, ['commit', '-qa', '-m', 'second']);
  return dir;
}

describe('parseLog', () => {
  test('parses US-separated fields, RS-terminated records; ignores blanks', () => {
    const a = ['abc1234', 'abc1', 'first', 'Al', 'al@x', '2 hours ago', '2026-06-14T10:00:00-05:00'];
    const b = ['def5678', 'def5', 'second', 'Bo', 'bo@x', '1 hour ago', '2026-06-14T11:00:00-05:00'];
    const text = `${a.join(US)}${RS}\n${b.join(US)}${RS}\n`;
    expect(parseLog(text)).toEqual([
      {
        sha: 'abc1234',
        shortSha: 'abc1',
        subject: 'first',
        author: 'Al',
        email: 'al@x',
        relativeDate: '2 hours ago',
        date: '2026-06-14T10:00:00-05:00',
      },
      {
        sha: 'def5678',
        shortSha: 'def5',
        subject: 'second',
        author: 'Bo',
        email: 'bo@x',
        relativeDate: '1 hour ago',
        date: '2026-06-14T11:00:00-05:00',
      },
    ]);
  });

  test('empty input → no commits', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('log + commit diff (real repo)', () => {
  test('lists commits newest-first and shows a commit’s files + diff', async () => {
    const app = asApp(await repoWithCommits());
    const log = await getAppLog(app);
    expect(log.ok).toBe(true);
    expect(log.commits.map((c) => c.subject)).toEqual(['second', 'first']);

    const head = log.commits[0].sha;
    const files = await getAppCommitFiles(app, head);
    expect(files.ok).toBe(true);
    expect(files.files.map((f) => f.path)).toEqual(['a.txt']);

    const fileDiff = await getAppCommitFileDiff(app, head, 'a.txt');
    expect(fileDiff.diff).toContain('+two');

    // A bad sha is rejected before reaching git.
    expect((await getAppCommitFiles(app, 'not-a-sha; rm -rf /')).ok).toBe(false);
  });
});
