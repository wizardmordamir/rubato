import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../lib/apps';
import { git } from '../lib/git';
import { buildPrArgs, detectPrHost, openAppPr } from './appPr';

const asApp = (dir: string): AppConfig => ({ absolutePath: dir, name: 'x' }) as AppConfig;

describe('detectPrHost', () => {
  test('maps origins to github/gitlab, else null', () => {
    expect(detectPrHost('https://github.com/org/repo.git')).toBe('github');
    expect(detectPrHost('git@gitlab.com:org/repo.git')).toBe('gitlab');
    expect(detectPrHost('https://bitbucket.org/org/repo')).toBeNull();
    expect(detectPrHost(null)).toBeNull();
  });
});

describe('buildPrArgs', () => {
  test('github: --fill by default; title/base/draft when given', () => {
    expect(buildPrArgs('github', {})).toEqual(['gh', 'pr', 'create', '--fill']);
    expect(buildPrArgs('github', { title: 'My PR', base: 'main', draft: true })).toEqual([
      'gh',
      'pr',
      'create',
      '--title',
      'My PR',
      '--body',
      '',
      '--base',
      'main',
      '--draft',
    ]);
  });
  test('gitlab: --fill --yes; title/target-branch/draft when given', () => {
    expect(buildPrArgs('gitlab', {})).toEqual(['glab', 'mr', 'create', '--fill', '--yes']);
    expect(buildPrArgs('gitlab', { title: 'My MR', base: 'develop', draft: true })).toEqual([
      'glab',
      'mr',
      'create',
      '--fill',
      '--yes',
      '--title',
      'My MR',
      '--target-branch',
      'develop',
      '--draft',
    ]);
  });
});

async function repoWithOrigin(origin: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rubato-pr-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@t.test']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['remote', 'add', 'origin', origin]);
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

describe('openAppPr guards (no CLI / network needed)', () => {
  test('non-github/gitlab origin → clear error', async () => {
    const app = asApp(await repoWithOrigin('https://bitbucket.org/org/repo.git'));
    const res = await openAppPr(app, {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('GitHub or GitLab');
  });

  test('github origin but unpushed branch → asks to push first', async () => {
    const app = asApp(await repoWithOrigin('https://github.com/org/repo.git'));
    const res = await openAppPr(app, {});
    expect(res.ok).toBe(false);
    expect(res.host).toBe('github');
    expect(res.error).toContain('push');
  });
});
