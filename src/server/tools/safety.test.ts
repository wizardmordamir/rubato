import { describe, expect, test } from 'bun:test';
import { globToRegExp, isSecretPath, resolveRepoPath } from './safety';

const ROOT = '/repo/app';

describe('resolveRepoPath', () => {
  test('accepts a normal in-repo path', () => {
    const r = resolveRepoPath(ROOT, 'src/routes.tsx');
    expect(r).toEqual({ ok: true, abs: '/repo/app/src/routes.tsx', rel: 'src/routes.tsx' });
  });

  test('refuses traversal escape', () => {
    expect(resolveRepoPath(ROOT, '../other/secrets.txt').ok).toBe(false);
    expect(resolveRepoPath(ROOT, 'src/../../etc/passwd').ok).toBe(false);
  });

  test('refuses an absolute path outside the repo', () => {
    expect(resolveRepoPath(ROOT, '/etc/passwd').ok).toBe(false);
  });

  test('refuses secret files even inside the repo', () => {
    expect(resolveRepoPath(ROOT, '.env').ok).toBe(false);
    expect(resolveRepoPath(ROOT, 'server/.env.production').ok).toBe(false);
    expect(resolveRepoPath(ROOT, 'certs/server.key').ok).toBe(false);
  });

  test('refuses an empty path', () => {
    expect(resolveRepoPath(ROOT, '  ').ok).toBe(false);
  });
});

describe('isSecretPath', () => {
  test('flags credential-ish files', () => {
    for (const p of ['.env', 'a/.env.local', 'id_rsa', 'deep/.ssh/config', 'x.pem', 'config/secrets.yml']) {
      expect(isSecretPath(p)).toBe(true);
    }
  });
  test('leaves ordinary source files alone', () => {
    for (const p of ['src/routes.tsx', 'README.md', 'env.sample', 'server/envParse.ts']) {
      expect(isSecretPath(p)).toBe(false);
    }
  });
});

describe('globToRegExp', () => {
  test('* stays within a path segment; ** crosses', () => {
    expect(globToRegExp('*.tsx').test('routes.tsx')).toBe(true);
    expect(globToRegExp('*.tsx').test('ui/routes.tsx')).toBe(false);
    expect(globToRegExp('**/*.tsx').test('ui/src/routes.tsx')).toBe(true);
  });
});
