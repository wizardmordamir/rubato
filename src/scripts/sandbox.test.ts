import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildBashRc, buildZshRc, DEFAULT_APPS, parseAppSpecs, resolveSandboxDir, sandboxPaths } from './sandbox';

describe('resolveSandboxDir', () => {
  test('defaults under the system temp dir', () => {
    expect(resolveSandboxDir({})).toBe(resolve(tmpdir(), 'rubato-sandbox'));
  });

  test('honors RUBATO_SANDBOX override', () => {
    expect(resolveSandboxDir({ RUBATO_SANDBOX: '/srv/box' })).toBe('/srv/box');
  });

  test('trims and ignores a blank override', () => {
    expect(resolveSandboxDir({ RUBATO_SANDBOX: '   ' })).toBe(resolve(tmpdir(), 'rubato-sandbox'));
  });
});

describe('parseAppSpecs', () => {
  test('defaults when no arg', () => {
    expect(parseAppSpecs(undefined)).toEqual(DEFAULT_APPS);
  });

  test('splits, trims, and strips stray slashes', () => {
    expect(parseAppSpecs('api, web ,/group/svc/')).toEqual(['api', 'web', 'group/svc']);
  });

  test('falls back to defaults when the list is empty', () => {
    expect(parseAppSpecs(' , ,')).toEqual(DEFAULT_APPS);
  });
});

describe('sandboxPaths', () => {
  test('derives code/.rubato/shell under the root', () => {
    const p = sandboxPaths('/box');
    expect(p).toEqual({ root: '/box', code: '/box/code', rubato: '/box/.rubato', shellDir: '/box/shell' });
  });
});

describe('shell rc generation', () => {
  const p = sandboxPaths('/box');

  test('zsh rc isolates RUBATO_HOME and sources sandbox aliases', () => {
    const rc = buildZshRc(p);
    expect(rc).toContain("export RUBATO_HOME='/box/.rubato'");
    expect(rc).toContain("source '/box/shell/aliases.sh'");
    expect(rc).toContain('source "$HOME/.zshrc"');
    expect(rc).toContain('(rubato-sandbox)');
  });

  test('bash rc isolates RUBATO_HOME and sets PS1', () => {
    const rc = buildBashRc(p);
    expect(rc).toContain("export RUBATO_HOME='/box/.rubato'");
    expect(rc).toContain('source "$HOME/.bashrc"');
    expect(rc).toContain('(rubato-sandbox)');
  });
});
