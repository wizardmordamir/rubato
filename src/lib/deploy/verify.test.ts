import { describe, expect, test } from 'bun:test';
import type { AppConfig } from '../apps';
import { matchAppForLabel } from './verify';

const app = (over: Partial<AppConfig>): AppConfig =>
  ({ name: 'x', absolutePath: '/x', dirName: 'x', group: null, aliases: [], ...over }) as AppConfig;

describe('matchAppForLabel', () => {
  const apps = [
    app({ name: 'my-app', dirName: 'my-app', apis: [{ name: 'quay', repository: 'team/my-app' }] }),
    app({ name: 'other', dirName: 'other', apis: [{ name: 'jenkins', project: 'team/my-other' }] }),
  ];

  test("matches by the label's last path segment against registry keys", () => {
    expect(matchAppForLabel('team/my-app', apps)?.name).toBe('my-app');
  });

  test("matches by the configured Quay repository's last segment", () => {
    // label uses the Jenkins-ish 'team/my-app'; falls through to Quay repo match
    expect(matchAppForLabel('my-app', apps)?.name).toBe('my-app');
  });

  test("matches by the Jenkins project's last segment", () => {
    expect(matchAppForLabel('ns/my-other', apps)?.name).toBe('other');
  });

  test('returns null when nothing resolves', () => {
    expect(matchAppForLabel('totally/unknown', apps)).toBeNull();
  });
});
