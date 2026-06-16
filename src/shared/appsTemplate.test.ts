import { expect, test } from 'bun:test';
import {
  expandHomeToken,
  fromTemplateEntry,
  HOME_TOKEN,
  isOutsideHome,
  normalizeHomedir,
  parseTemplateEntries,
  resolveEntryStatus,
  sortTemplateEntries,
  type TemplateEntry,
  tokenizeHomePath,
  toTemplateEntry,
  validateTemplateEntry,
} from './appsTemplate';

const HOME = '/Users/alice';

test('expandHomeToken expands <HOME> and ~ to the given home dir', () => {
  expect(expandHomeToken('<HOME>/.zshrc', HOME)).toBe('/Users/alice/.zshrc');
  expect(expandHomeToken('<HOME>', HOME)).toBe('/Users/alice');
  expect(expandHomeToken('~/code/foo', HOME)).toBe('/Users/alice/code/foo');
  expect(expandHomeToken('~', HOME)).toBe('/Users/alice');
  // an absolute path with no token is untouched
  expect(expandHomeToken('/opt/tools', HOME)).toBe('/opt/tools');
});

test('expandHomeToken collapses a trailing slash on home so it never doubles', () => {
  expect(expandHomeToken('<HOME>/.zshrc', '/Users/alice/')).toBe('/Users/alice/.zshrc');
});

test('tokenizeHomePath rewrites a home-relative path with <HOME>, leaves others alone', () => {
  expect(tokenizeHomePath('/Users/alice/.zshrc', HOME)).toBe('<HOME>/.zshrc');
  expect(tokenizeHomePath('/Users/alice', HOME)).toBe(HOME_TOKEN);
  expect(tokenizeHomePath('/opt/tools', HOME)).toBe('/opt/tools');
  // a different user's home is NOT under ours → unchanged
  expect(tokenizeHomePath('/Users/bob/.zshrc', HOME)).toBe('/Users/bob/.zshrc');
});

test('tokenize then expand round-trips a home path back to absolute', () => {
  const abs = '/Users/alice/code/myrepo';
  expect(expandHomeToken(tokenizeHomePath(abs, HOME), HOME)).toBe(abs);
});

test('isOutsideHome flags paths the <HOME> token cannot cover', () => {
  expect(isOutsideHome('/opt/tools', HOME)).toBe(true);
  expect(isOutsideHome('/Users/alice/.zshrc', HOME)).toBe(false);
});

test('toTemplateEntry strips per-machine derived fields and tokenizes the path', () => {
  const app = {
    name: 'zshrc',
    absolutePath: '/Users/alice/.zshrc',
    aliases: ['zsh'],
    group: null,
    dirName: '.zshrc',
    repoName: 'whatever',
    packageJsonName: 'pkg',
    managed: true,
    missing: false,
    pinned: true,
    links: [{ text: 'docs', href: 'https://x' }],
  };
  const entry = toTemplateEntry(app, HOME);
  expect(entry.absolutePath).toBe('<HOME>/.zshrc');
  expect(entry.aliases).toEqual(['zsh']);
  expect(entry.pinned).toBe(true);
  expect(entry.links).toEqual([{ text: 'docs', href: 'https://x' }]);
  // derived/per-machine fields are gone
  expect(entry.dirName).toBeUndefined();
  expect(entry.repoName).toBeUndefined();
  expect(entry.packageJsonName).toBeUndefined();
  expect(entry.managed).toBeUndefined();
  expect(entry.missing).toBeUndefined();
});

test('fromTemplateEntry resolves the path, re-derives dirName, marks it hand-added', () => {
  const entry: TemplateEntry = { name: 'config', absolutePath: '<HOME>/.rubato/apps.json', aliases: ['cfg'] };
  const app = fromTemplateEntry(entry, HOME);
  expect(app.absolutePath).toBe('/Users/alice/.rubato/apps.json');
  expect(app.dirName).toBe('apps.json');
  expect(app.managed).toBe(false);
  expect(app.aliases).toEqual(['cfg']);
});

test('resolveEntryStatus marks applied by name (case-insensitive) and flags path drift', () => {
  const apps = [{ name: 'Zshrc', absolutePath: '/Users/alice/dotfiles/.zshrc' }];
  const entry: TemplateEntry = { name: 'zshrc', absolutePath: '<HOME>/.zshrc' };
  const s = resolveEntryStatus(entry, apps, HOME);
  expect(s.applied).toBe(true);
  expect(s.resolvedPath).toBe('/Users/alice/.zshrc');
  expect(s.appliedPath).toBe('/Users/alice/dotfiles/.zshrc');
  expect(s.pathMismatch).toBe(true);
});

test('resolveEntryStatus matches by resolved path when names differ', () => {
  const apps = [{ name: 'shell-rc', absolutePath: '/Users/alice/.zshrc' }];
  const entry: TemplateEntry = { name: 'zshrc', absolutePath: '<HOME>/.zshrc' };
  const s = resolveEntryStatus(entry, apps, HOME);
  expect(s.applied).toBe(true);
  expect(s.pathMismatch).toBe(false);
});

test('resolveEntryStatus reports not-applied when nothing matches', () => {
  const s = resolveEntryStatus({ name: 'newapp', absolutePath: '<HOME>/code/new' }, [], HOME);
  expect(s.applied).toBe(false);
  expect(s.appliedPath).toBeUndefined();
  expect(s.pathMismatch).toBe(false);
});

test('normalizeHomedir rewrites ${homedir()} / ${os.homedir()} to <HOME> in strings', () => {
  expect(normalizeHomedir('${homedir()}/.zshrc')).toBe('<HOME>/.zshrc');
  expect(normalizeHomedir('${ os.homedir() }/.config')).toBe('<HOME>/.config');
  expect(normalizeHomedir({ absolutePath: '${homedir()}/.codeium', aliases: ['x'] })).toEqual({
    absolutePath: '<HOME>/.codeium',
    aliases: ['x'],
  });
});

test('parseTemplateEntries accepts a loose JS object with ${homedir()} and normalizes it', () => {
  const r = parseTemplateEntries("{ name: 'codeium', aliases: ['codeium'], absolutePath: `${homedir()}/.codeium`, }");
  expect(r.ok).toBe(true);
  expect(r.entries).toEqual([{ name: 'codeium', aliases: ['codeium'], absolutePath: '<HOME>/.codeium' }]);
});

test('parseTemplateEntries accepts an array of entries', () => {
  const r = parseTemplateEntries('[{ name: "a", absolutePath: "<HOME>/a" }, { name: "b", absolutePath: "~/b" }]');
  expect(r.ok).toBe(true);
  expect(r.entries?.map((e) => e.name)).toEqual(['a', 'b']);
});

test('parseTemplateEntries reports a clear error for bad syntax', () => {
  const r = parseTemplateEntries('{ name: }');
  expect(r.ok).toBe(false);
  expect(r.error).toBeTruthy();
});

test('parseTemplateEntries rejects an entry missing required fields', () => {
  expect(parseTemplateEntries('{ aliases: ["x"] }').ok).toBe(false);
  expect(parseTemplateEntries('{ name: "x" }').ok).toBe(false);
});

test('validateTemplateEntry rejects a non-string aliases array', () => {
  expect(() => validateTemplateEntry({ name: 'x', absolutePath: '<HOME>/x', aliases: [1] })).toThrow();
});

test('sortTemplateEntries orders by name, case-insensitive, without mutating input', () => {
  const input: TemplateEntry[] = [
    { name: 'Zsh', absolutePath: '<HOME>/.zshrc' },
    { name: 'bash', absolutePath: '<HOME>/.bashrc' },
    { name: 'Atom', absolutePath: '<HOME>/.atom' },
  ];
  const sorted = sortTemplateEntries(input);
  expect(sorted.map((e) => e.name)).toEqual(['Atom', 'bash', 'Zsh']);
  expect(input[0].name).toBe('Zsh'); // original untouched
});
