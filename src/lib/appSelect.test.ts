import { describe, expect, test } from 'bun:test';
import { appMatchesFilter, matchesGroup, selectApps } from './appSelect';
import type { AppConfig } from './apps';

function app(over: Partial<AppConfig> & { name: string }): AppConfig {
  return { absolutePath: `/code/${over.name}`, dirName: over.name, group: null, aliases: [], ...over };
}

describe('matchesGroup', () => {
  test('exact and nested matches; null never matches', () => {
    expect(matchesGroup('github', 'github')).toBe(true);
    expect(matchesGroup('work/fb', 'work')).toBe(true);
    expect(matchesGroup('workspace', 'work')).toBe(false); // not a path boundary
    expect(matchesGroup(null, 'work')).toBe(false);
  });
});

describe('appMatchesFilter', () => {
  const a = app({ name: 'myapp', group: 'services', aliases: ['ma'] });
  test('matches by group', () => expect(appMatchesFilter(a, 'services')).toBe(true));
  test('matches by name/alias (case-insensitive)', () => {
    expect(appMatchesFilter(a, 'MYAPP')).toBe(true);
    expect(appMatchesFilter(a, 'ma')).toBe(true);
  });
  test('no match', () => expect(appMatchesFilter(a, 'burger')).toBe(false));
});

describe('selectApps', () => {
  const apps = [
    app({ name: 'a', group: 'github', aliases: ['ay'] }),
    app({ name: 'b', group: 'work/fb' }),
    app({ name: 'c', group: 'github', ignoreCommandTypes: ['git'] }),
    app({ name: 'd', group: 'github', missing: true }),
  ];

  test('filter by group (including nested)', () => {
    expect(selectApps(apps, { filter: 'github' }).map((a) => a.name)).toEqual(['a', 'c']); // d is missing
    expect(selectApps(apps, { filter: 'work' }).map((a) => a.name)).toEqual(['b']);
  });

  test('filter by a single app (name or alias)', () => {
    expect(selectApps(apps, { filter: 'b' }).map((a) => a.name)).toEqual(['b']);
    expect(selectApps(apps, { filter: 'ay' }).map((a) => a.name)).toEqual(['a']);
  });

  test('excludes apps that ignore the command category', () => {
    expect(selectApps(apps, { filter: 'github', command: 'git' }).map((a) => a.name)).toEqual(['a']);
  });

  test('no filter returns all (minus missing)', () => {
    expect(selectApps(apps).map((a) => a.name)).toEqual(['a', 'b', 'c']);
  });
});
