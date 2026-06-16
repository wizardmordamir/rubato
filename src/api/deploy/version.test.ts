import { describe, expect, test } from 'bun:test';
import type { JenkinsBuild } from '../jenkins/types';
import { buildNumberFromVersion, parseVersion, versionFromBuild } from './version';

const build = (over: Partial<JenkinsBuild>): JenkinsBuild => ({
  number: 1,
  url: 'u',
  result: 'SUCCESS',
  building: false,
  timestamp: 0,
  ...over,
});

describe('parseVersion', () => {
  test('splits segments and trailing', () => {
    expect(parseVersion('1.1.13.739')).toEqual({ segments: [1, 1, 13, 739], trailing: 739 });
  });
  test('non-numeric trailing → null', () => {
    expect(parseVersion('1.0.0-rc').trailing).toBeNull();
  });
});

describe('buildNumberFromVersion', () => {
  test('returns the trailing segment (739 — note: NOT the real build #740)', () => {
    expect(buildNumberFromVersion('1.1.13.739')).toBe(739);
  });
});

describe('versionFromBuild', () => {
  test("prefers a configured param, ignoring 'latest'", () => {
    const b = build({
      actions: [{ _class: 'x', parameters: [{ name: 'IMAGE_VERSION', value: '1.1.13.739' }] }],
    });
    expect(versionFromBuild(b, { param: 'IMAGE_VERSION' })).toBe('1.1.13.739');

    const latest = build({
      actions: [{ _class: 'x', parameters: [{ name: 'RELEASE_VERSION', value: 'latest' }] }],
    });
    expect(versionFromBuild(latest, { param: 'RELEASE_VERSION' })).toBeNull();
  });

  test('falls back to a dotted version in displayName', () => {
    expect(versionFromBuild(build({ displayName: 'release 1.2.3.45 build' }))).toBe('1.2.3.45');
  });

  test("returns null when displayName is just '#740' (the real-world case)", () => {
    expect(versionFromBuild(build({ displayName: '#740', fullDisplayName: 'team » my-app #740' }))).toBeNull();
  });
});
