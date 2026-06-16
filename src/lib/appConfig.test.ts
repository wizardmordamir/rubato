import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type AppConfig, getAppApi, gotoTarget, ignoresCommand } from './apps';

function app(over: Partial<AppConfig> & { name: string; absolutePath: string }): AppConfig {
  return { dirName: over.name, group: null, aliases: [], ...over };
}

describe('getAppApi', () => {
  const a = app({
    name: 'svc',
    absolutePath: '/code/svc',
    apis: [
      { name: 'jenkins', project: 'Deploys/svc', multibranch: true },
      { name: 'gitlab', project: 'svc', namespace: 'team' },
    ],
  });

  test('returns the typed config for a known api', () => {
    const jenkins = getAppApi(a, 'jenkins');
    expect(jenkins?.project).toBe('Deploys/svc');
    expect(jenkins?.multibranch).toBe(true);
    expect(getAppApi(a, 'gitlab')?.namespace).toBe('team');
  });

  test("returns undefined when the api isn't configured", () => {
    expect(getAppApi(a, 'quay')).toBeUndefined();
    expect(getAppApi(app({ name: 'x', absolutePath: '/x' }), 'jenkins')).toBeUndefined();
  });
});

describe('ignoresCommand', () => {
  test('reflects ignoreCommandTypes', () => {
    const a = app({ name: 'x', absolutePath: '/x', ignoreCommandTypes: ['git'] });
    expect(ignoresCommand(a, 'git')).toBe(true);
    expect(ignoresCommand(a, 'deploy')).toBe(false);
    expect(ignoresCommand(app({ name: 'y', absolutePath: '/y' }), 'git')).toBe(false);
  });
});

describe('gotoTarget', () => {
  test('returns a directory path unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-test-'));
    expect(await gotoTarget(dir)).toBe(dir);
  });

  test('returns the containing dir for a file entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-test-'));
    const file = join(dir, '.zshrc');
    await Bun.write(file, '# test');
    expect(await gotoTarget(file)).toBe(dirname(file));
  });

  test("falls back to the path when it doesn't exist (cd surfaces the error)", async () => {
    expect(await gotoTarget('/no/such/path/xyz')).toBe('/no/such/path/xyz');
  });
});
