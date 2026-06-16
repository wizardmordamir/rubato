import { describe, expect, test } from 'bun:test';
import { resolveTagRef } from './dashboardRoutes';

describe('resolveTagRef', () => {
  test('blank / latest / HEAD all mean HEAD (undefined → tagCommit tags HEAD)', () => {
    expect(resolveTagRef(undefined)).toBeUndefined();
    expect(resolveTagRef('')).toBeUndefined();
    expect(resolveTagRef('  ')).toBeUndefined();
    expect(resolveTagRef('latest')).toBeUndefined();
    expect(resolveTagRef('LATEST')).toBeUndefined();
    expect(resolveTagRef('Head')).toBeUndefined();
  });

  test('an explicit ref is passed through (trimmed)', () => {
    expect(resolveTagRef('main')).toBe('main');
    expect(resolveTagRef('  abc123 ')).toBe('abc123');
    expect(resolveTagRef('origin/release')).toBe('origin/release');
  });
});
