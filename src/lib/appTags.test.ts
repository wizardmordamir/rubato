import { describe, expect, test } from 'bun:test';
import { type AppConfig, effectiveAppTags, findAppByPath, normalizeStringList } from './apps';

const app = (over: Partial<AppConfig>): AppConfig => ({
  name: 'x',
  absolutePath: '/code/x',
  dirName: 'x',
  group: null,
  aliases: [],
  ...over,
});

describe('effectiveAppTags', () => {
  test('unions db + apis + cloneUrl host + manual tags, deduped + lowercased + sorted', () => {
    const a = app({
      db: ['MongoDB'],
      apis: [{ name: 'jenkins' }, { name: 'rancher', cluster: 'c1' }],
      cloneUrl: 'git@github.com:me/x.git',
      tags: ['Harness', 'jenkins'], // 'jenkins' duplicates the api → collapses
    });
    expect(effectiveAppTags(a)).toEqual(['github', 'harness', 'jenkins', 'mongodb', 'rancher']);
  });

  test('infers gitlab from a gitlab clone url', () => {
    expect(effectiveAppTags(app({ cloneUrl: 'https://gitlab.com/me/x.git' }))).toEqual(['gitlab']);
  });

  test('empty when nothing is set', () => {
    expect(effectiveAppTags(app({}))).toEqual([]);
  });
});

describe('normalizeStringList', () => {
  test('trims, lowercases, drops blanks/non-strings, dedupes', () => {
    expect(normalizeStringList([' Postgres ', 'postgres', '', 5, 'redis'])).toEqual(['postgres', 'redis']);
  });
});

describe('findAppByPath', () => {
  const apps = [app({ name: 'x', absolutePath: '/code/x' }), app({ name: 'mono', absolutePath: '/code/mono' })];
  test('exact match', () => {
    expect(findAppByPath('/code/x', apps)?.name).toBe('x');
  });
  test('nearest ancestor for a path inside an app dir', () => {
    expect(findAppByPath('/code/mono/packages/api', apps)?.name).toBe('mono');
  });
  test('null when outside every app', () => {
    expect(findAppByPath('/elsewhere/y', apps)).toBeNull();
  });
});
