import { describe, expect, test } from 'bun:test';
import { type IgnoreLayer, isIgnored, parseGitignore } from './gitignore';

/** Convenience: one root-level layer from gitignore text. */
function layer(text: string, base = ''): IgnoreLayer {
  return { base, rules: parseGitignore(text) };
}

describe('parseGitignore', () => {
  test('skips blank lines and comments', () => {
    expect(parseGitignore('\n# a comment\n\n  \n')).toEqual([]);
  });

  test('escaped leading # is a literal pattern', () => {
    const [l] = [layer('\\#keep')];
    expect(isIgnored([l], '#keep', false)).toBe(true);
  });
});

describe('isIgnored', () => {
  const ignored = (text: string, path: string, isDir = false) => isIgnored([layer(text)], path, isDir);

  test('basename pattern matches at any depth', () => {
    expect(ignored('node_modules', 'node_modules', true)).toBe(true);
    expect(ignored('node_modules', 'a/b/node_modules', true)).toBe(true);
    expect(ignored('node_modules', 'a/b/node_modules/pkg/index.js', false)).toBe(true);
  });

  test('anchored pattern (leading slash) only matches at root', () => {
    expect(ignored('/dist', 'dist', true)).toBe(true);
    expect(ignored('/dist', 'dist/app.js', false)).toBe(true);
    expect(ignored('/dist', 'src/dist', true)).toBe(false);
  });

  test('mid-pattern slash anchors', () => {
    expect(ignored('src/generated', 'src/generated', true)).toBe(true);
    expect(ignored('src/generated', 'lib/src/generated', true)).toBe(false);
  });

  test('trailing slash matches directories only', () => {
    expect(ignored('build/', 'build', true)).toBe(true);
    expect(ignored('build/', 'build', false)).toBe(false); // a file named build
  });

  test('star does not cross slashes', () => {
    expect(ignored('*.log', 'error.log', false)).toBe(true);
    expect(ignored('*.log', 'logs/error.log', false)).toBe(true);
    expect(ignored('*.log', 'error.log.txt', false)).toBe(false);
  });

  test('question mark matches a single non-slash char', () => {
    expect(ignored('foo.?s', 'foo.js', false)).toBe(true);
    expect(ignored('foo.?s', 'foo.ts', false)).toBe(true);
    expect(ignored('foo.?s', 'foo.tsx', false)).toBe(false);
  });

  test('leading **/ matches at any depth', () => {
    expect(ignored('**/secret.txt', 'secret.txt', false)).toBe(true);
    expect(ignored('**/secret.txt', 'a/b/secret.txt', false)).toBe(true);
  });

  test('trailing /** matches everything inside', () => {
    expect(ignored('logs/**', 'logs/a/b.txt', false)).toBe(true);
    expect(ignored('logs/**', 'logs', true)).toBe(false); // the dir itself isn't matched
  });

  test('middle /**/ spans zero or more dirs', () => {
    expect(ignored('a/**/b', 'a/b', false)).toBe(true);
    expect(ignored('a/**/b', 'a/x/b', false)).toBe(true);
    expect(ignored('a/**/b', 'a/x/y/b', false)).toBe(true);
    expect(ignored('a/**/b', 'a/x/c', false)).toBe(false);
  });

  test('negation re-includes; last match wins', () => {
    const rules = layer('*.log\n!keep.log');
    expect(isIgnored([rules], 'error.log', false)).toBe(true);
    expect(isIgnored([rules], 'keep.log', false)).toBe(false);
  });

  test('deeper layer overrides a shallower one', () => {
    const root = layer('*.env', '');
    const nested = layer('!local.env', 'src');
    expect(isIgnored([root, nested], 'src/local.env', false)).toBe(false);
    expect(isIgnored([root, nested], 'other.env', false)).toBe(true);
  });

  test('rubato conventions: ___ dirs/files and *.ignore.* files', () => {
    const conv = layer('___*\n*.ignore.*');
    expect(isIgnored([conv], '___Notes', true)).toBe(true);
    expect(isIgnored([conv], 'src/___scratch.ts', false)).toBe(true);
    expect(isIgnored([conv], 'src/dead.ignore.ts', false)).toBe(true);
    expect(isIgnored([conv], 'src/main.ts', false)).toBe(false);
  });
});
