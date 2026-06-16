import { describe, expect, test } from 'bun:test';
import { matchEnvKeys } from './envDiscovery';

const env = { API_URL: 'https://x', API_TOKEN: 'secret', DATABASE_URL: 'pg://db', PORT: '5432' };

describe('matchEnvKeys', () => {
  test('matches key names case-insensitively (substring)', () => {
    expect(matchEnvKeys(env, 'api', '')).toEqual(['API_TOKEN', 'API_URL']);
    expect(matchEnvKeys(env, 'URL', '')).toEqual(['API_URL', 'DATABASE_URL']);
    expect(matchEnvKeys(env, 'nope', '')).toEqual([]);
  });

  test('value filter narrows to keys whose value contains it', () => {
    expect(matchEnvKeys(env, 'url', 'pg://')).toEqual(['DATABASE_URL']);
    expect(matchEnvKeys(env, '', '5432')).toEqual(['PORT']); // value-only search
    expect(matchEnvKeys(env, 'api', 'nomatch')).toEqual([]);
  });

  test("an empty query matches nothing (caller treats that as 'list everything')", () => {
    expect(matchEnvKeys(env, '', '')).toEqual([]);
  });
});
