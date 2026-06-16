import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { appDataDir } from './appData';

describe('appDataDir', () => {
  test('defaults to ~/.<name> (home-based, cross-platform, binary-safe)', () => {
    expect(appDataDir('app-output-files')).toBe(resolve(homedir(), '.app-output-files'));
  });

  test('an env override wins and expands ~', () => {
    const KEY = 'RU_APPDATA_TEST_OVERRIDE';
    process.env[KEY] = '~/somewhere/data';
    try {
      expect(appDataDir('ignored', { env: KEY })).toBe(resolve(homedir(), 'somewhere/data'));
    } finally {
      delete process.env[KEY];
    }
  });

  test('an absolute env override is used as-is', () => {
    const KEY = 'RU_APPDATA_TEST_ABS';
    process.env[KEY] = '/var/data/app';
    try {
      expect(appDataDir('ignored', { env: KEY })).toBe('/var/data/app');
    } finally {
      delete process.env[KEY];
    }
  });

  test('falls back to the default when the env var is unset/blank', () => {
    expect(appDataDir('my-tool', { env: 'RU_DEFINITELY_UNSET_VAR' })).toBe(resolve(homedir(), '.my-tool'));
  });

  test('sanitizes the name to one safe segment (no home-dir escape)', () => {
    // separators + dots collapse away → a single dot-dir directly under home
    expect(appDataDir('../../etc')).toBe(resolve(homedir(), '.etc'));
    expect(appDataDir('.hidden')).toBe(resolve(homedir(), '.hidden'));
    expect(appDataDir('a/b\\c')).toBe(resolve(homedir(), '.a-b-c'));
  });
});
