import { afterAll, describe, expect, test } from 'bun:test';
import { basename } from 'node:path';
import {
  type AppConfig,
  findMatches,
  hasUserData,
  keySources,
  loadApps,
  matchKeys,
  normalizeAppLinks,
  removeApp,
  resolveAppNamespace,
  resolveAppOrPath,
  saveApps,
  tryResolveAppOrPath,
  validateApps,
  validateAppsDetailed,
} from './apps';
import { APPS_FILE } from './config';

function app(over: Partial<AppConfig> & { name: string; absolutePath: string }): AppConfig {
  return {
    dirName: over.name,
    group: null,
    aliases: [],
    managed: true,
    ...over,
  };
}

describe('matchKeys', () => {
  test('collapses identical name/dir/repo into one key and includes aliases', () => {
    const a = app({
      name: 'myapp',
      absolutePath: '/code/myapp',
      dirName: 'myapp',
      repoName: 'myapp',
      packageJsonName: '@acme/myapp',
      aliases: ['ma', 'Myapp'], // "Myapp" dedupes against "myapp" case-insensitively
    });
    expect(matchKeys(a)).toEqual(['myapp', '@acme/myapp', 'ma']);
  });

  test('ignores empty/whitespace values', () => {
    const a = app({ name: 'x', absolutePath: '/code/x', aliases: ['', '  '] });
    expect(matchKeys(a)).toEqual(['x']);
  });
});

describe('validateApps', () => {
  test('clean registry has no errors', () => {
    const apps = [app({ name: 'a', absolutePath: '/code/a' }), app({ name: 'b', absolutePath: '/code/b' })];
    expect(validateApps(apps)).toEqual([]);
  });

  test('flags duplicate name, duplicate path, and shared match key (deduped)', () => {
    const apps = [
      app({ name: 'a', absolutePath: '/code/a', aliases: ['shared'] }),
      app({ name: 'b', absolutePath: '/code/b', aliases: ['shared'] }),
    ];
    const errors = validateApps(apps);
    expect(errors.some((e) => e.includes('"shared"'))).toBe(true);

    const dupName = validateApps([
      app({ name: 'same', absolutePath: '/code/one' }),
      app({ name: 'Same', absolutePath: '/code/two' }),
    ]);
    expect(dupName.some((e) => e.toLowerCase().includes('duplicate name'))).toBe(true);

    const dupPath = validateApps([
      app({ name: 'x', absolutePath: '/code/dup' }),
      app({ name: 'y', absolutePath: '/code/dup' }),
    ]);
    expect(dupPath.some((e) => e.includes('Duplicate absolutePath'))).toBe(true);
  });

  test('an app keying the same value many ways is not a self-conflict', () => {
    const a = app({
      name: 'cwip',
      absolutePath: '/code/cwip',
      dirName: 'cwip',
      repoName: 'cwip',
      packageJsonName: 'cwip',
    });
    expect(validateApps([a])).toEqual([]);
  });
});

describe('keySources', () => {
  test('maps each field to the path to inspect', () => {
    const a = app({
      name: 'Title',
      absolutePath: '/code/repo',
      dirName: 'repo',
      repoName: 'remote-repo',
      packageJsonName: '@acme/pkg',
      aliases: ['nick'],
    });
    expect(keySources(a, '@acme/pkg')).toEqual([
      { field: 'packageJsonName', label: 'package.json name', path: '/code/repo/package.json' },
    ]);
    expect(keySources(a, 'remote-repo')).toEqual([
      { field: 'repoName', label: 'repo name (git remote)', path: '/code/repo' },
    ]);
    expect(keySources(a, 'repo')).toEqual([{ field: 'dirName', label: 'directory name', path: '/code/repo' }]);
    expect(keySources(a, 'title')).toEqual([{ field: 'name', label: 'name', path: APPS_FILE }]);
    expect(keySources(a, 'nick')).toEqual([{ field: 'aliases', label: 'alias', path: APPS_FILE }]);
    expect(keySources(a, 'absent')).toEqual([]);
  });
});

describe('validateAppsDetailed', () => {
  test('a package-name clash points at the offending package.json', () => {
    const apps = [
      app({ name: 'cursedalchemy', absolutePath: '/code/cursedalchemy', packageJsonName: 'family-site' }),
      app({ name: 'family-site', absolutePath: '/code/family-site' }),
    ];
    const conflicts = validateAppsDetailed(apps);
    const keyConflict = conflicts.find((c) => c.kind === 'match-key' && c.key === 'family-site');
    expect(keyConflict).toBeDefined();
    const claimant = keyConflict?.apps.find((a) => a.name === 'cursedalchemy');
    expect(claimant?.sources?.[0]).toEqual({
      field: 'packageJsonName',
      label: 'package.json name',
      path: '/code/cursedalchemy/package.json',
    });
  });
});

describe('resolveAppNamespace', () => {
  test("returns undefined when there's no openshift config", () => {
    expect(resolveAppNamespace(app({ name: 'a', absolutePath: '/a' }))).toBeUndefined();
  });

  test('returns the single namespace', () => {
    const a = app({ name: 'a', absolutePath: '/a', apis: [{ name: 'openshift', namespace: 'a-prod' }] });
    expect(resolveAppNamespace(a)).toBe('a-prod');
  });

  test('prefers a per-env namespace when an env is given, else falls back to the single one', () => {
    const a = app({
      name: 'a',
      absolutePath: '/a',
      apis: [{ name: 'openshift', namespace: 'a-prod', namespaces: { dev: 'a-dev', stage: 'a-stage' } }],
    });
    expect(resolveAppNamespace(a, 'dev')).toBe('a-dev');
    expect(resolveAppNamespace(a, 'stage')).toBe('a-stage');
    expect(resolveAppNamespace(a, 'unknown')).toBe('a-prod'); // no per-env entry → single
    expect(resolveAppNamespace(a)).toBe('a-prod');
  });
});

describe('findMatches', () => {
  const apps = [
    app({ name: 'myapp', absolutePath: '/code/myapp', aliases: ['ma'] }),
    app({ name: 'burger', absolutePath: '/code/burger' }),
  ];

  test('matches case-insensitively by name or alias', () => {
    expect(findMatches('MYAPP', apps).map((a) => a.name)).toEqual(['myapp']);
    expect(findMatches('ma', apps).map((a) => a.name)).toEqual(['myapp']);
  });

  test('returns empty when nothing matches', () => {
    expect(findMatches('taco', apps)).toEqual([]);
  });
});

describe('resolveAppOrPath', () => {
  // The test preload points RUBATO_HOME at an empty throwaway home, so the
  // registry is empty and any real path falls through to the filesystem branch.
  test('returns a real existing path when no app matches', async () => {
    const target = await resolveAppOrPath(import.meta.dir);
    expect(target.absolutePath).toBe(import.meta.dir);
    expect(target.name).toBe(basename(import.meta.dir));
  });
});

describe('tryResolveAppOrPath', () => {
  test("returns null when nothing matches and it isn't a real path", async () => {
    expect(await tryResolveAppOrPath('definitely-not-an-app-or-path')).toBeNull();
  });

  test('returns a real existing path when no app matches', async () => {
    const target = await tryResolveAppOrPath(import.meta.dir);
    expect(target?.absolutePath).toBe(import.meta.dir);
  });
});

describe('hasUserData', () => {
  test('false for a purely scan-derived entry', () => {
    expect(hasUserData(app({ name: 'repo', absolutePath: '/code/repo' }))).toBe(false);
  });

  test('true when aliases, a custom title, or extra metadata is present', () => {
    expect(hasUserData(app({ name: 'repo', absolutePath: '/code/repo', aliases: ['r'] }))).toBe(true);
    expect(hasUserData(app({ name: 'My Repo', absolutePath: '/code/repo', dirName: 'repo' }))).toBe(true);
    expect(hasUserData(app({ name: 'repo', absolutePath: '/code/repo', gitlab: { url: 'x' } }))).toBe(true);
  });
});

describe('removeApp', () => {
  // loadApps/saveApps hit the registry file under the isolated test RUBATO_HOME;
  // reset it after so the empty-registry assumptions elsewhere keep holding.
  afterAll(async () => {
    await saveApps([]);
  });

  test('drops the named entry, leaves the rest, and returns the removed app', async () => {
    await saveApps([
      app({ name: 'a', absolutePath: '/code/a' }),
      app({ name: 'b', absolutePath: '/code/b' }),
      app({ name: 'c', absolutePath: '/code/c' }),
    ]);
    const removed = await removeApp('b');
    expect(removed?.name).toBe('b');
    expect((await loadApps()).map((x) => x.name)).toEqual(['a', 'c']);
  });

  test('returns null and changes nothing for an unknown name', async () => {
    await saveApps([app({ name: 'a', absolutePath: '/code/a' })]);
    expect(await removeApp('nope')).toBeNull();
    expect((await loadApps()).map((x) => x.name)).toEqual(['a']);
  });
});

describe('normalizeAppLinks', () => {
  test('keeps valid links, trims, and defaults text to the href', () => {
    expect(
      normalizeAppLinks([
        { text: '  Jenkins ', href: ' https://ci/job ' },
        { href: 'https://quay.io/x' }, // no text → text = href
      ]),
    ).toEqual([
      { text: 'Jenkins', href: 'https://ci/job' },
      { text: 'https://quay.io/x', href: 'https://quay.io/x' },
    ]);
  });

  test('drops entries with a blank/absent/non-string href, and non-arrays → []', () => {
    expect(normalizeAppLinks([{ text: 'x', href: '  ' }, { text: 'y' }, { href: 42 }])).toEqual([]);
    expect(normalizeAppLinks(undefined)).toEqual([]);
    expect(normalizeAppLinks('nope')).toEqual([]);
  });
});
