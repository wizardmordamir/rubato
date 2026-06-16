import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../lib/apps';
import { loadApps, saveApps } from '../lib/apps';
import { git } from '../lib/git';
import {
  addAppsToTemplate,
  applyTemplateEntries,
  commitTemplate,
  createTemplateEntries,
  editTemplateEntry,
  getHiddenTemplates,
  getTemplateStatus,
  loadTemplate,
  removeTemplateEntries,
  saveTemplate,
  setHiddenTemplates,
  sortTemplate,
  templateDiff,
  templateGitStatus,
} from './appsTemplate';

// RUBATO_HOME is already isolated to a temp dir by src/test/setup.ts, so the
// registry (apps.json) writes are safe; here we additionally point the template
// at a temp file so we never read/write the repo's real apps.template.json.
const asApp = (over: Partial<AppConfig> & { name: string; absolutePath: string }): AppConfig =>
  ({ dirName: over.name, group: null, aliases: [], managed: false, ...over }) as AppConfig;

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'rubato-tpl-'));
  process.env.RUBATO_APPS_TEMPLATE = join(tmp, 'apps.template.json');
  await saveApps([]); // reset the isolated registry for each test
});

afterAll(() => {
  process.env.RUBATO_APPS_TEMPLATE = undefined;
});

describe('getTemplateStatus', () => {
  test('annotates applied, resolved <HOME>, and on-disk existence', async () => {
    const existing = join(tmp, 'real-file');
    await writeFile(existing, 'x');
    await saveTemplate([
      { name: 'has', absolutePath: existing, aliases: ['h'] },
      { name: 'gone', absolutePath: join(tmp, 'nope') },
      { name: 'homed', absolutePath: '<HOME>/.some-rubato-test-path' },
    ]);
    await saveApps([asApp({ name: 'has', absolutePath: existing })]);

    const status = await getTemplateStatus();
    expect(status.exists).toBe(true);
    expect(status.path).toBe(join(tmp, 'apps.template.json'));

    const byName = Object.fromEntries(status.entries.map((e) => [e.entry.name, e]));
    expect(byName.has.applied).toBe(true);
    expect(byName.has.pathExists).toBe(true);
    expect(byName.gone.applied).toBe(false);
    expect(byName.gone.pathExists).toBe(false);
    expect(byName.homed.resolvedPath.startsWith(homedir())).toBe(true);
  });

  test('a missing template file reads as empty, not an error', async () => {
    const status = await getTemplateStatus();
    expect(status.exists).toBe(false);
    expect(status.entries).toEqual([]);
  });
});

describe('applyTemplateEntries', () => {
  test('adds chosen entries (resolving <HOME>), skips name clashes', async () => {
    const dir = join(tmp, 'code');
    await mkdir(dir, { recursive: true });
    await saveTemplate([
      { name: 'newrepo', absolutePath: dir, aliases: ['nr'] },
      { name: 'dup', absolutePath: join(tmp, 'dup') },
    ]);
    await saveApps([asApp({ name: 'dup', absolutePath: '/somewhere/else' })]);

    const r = await applyTemplateEntries(['newrepo', 'dup']);
    expect(r.added).toEqual(['newrepo']);
    expect(r.skipped.map((s) => s.name)).toEqual(['dup']);

    const apps = await loadApps();
    const added = apps.find((a) => a.name === 'newrepo');
    expect(added?.absolutePath).toBe(dir);
    expect(added?.dirName).toBe('code');
    expect(added?.managed).toBe(false);
  });

  test('skips an entry whose match key (alias) is already taken', async () => {
    await saveTemplate([{ name: 'fresh', absolutePath: join(tmp, 'fresh'), aliases: ['shared'] }]);
    await saveApps([asApp({ name: 'other', absolutePath: '/x', aliases: ['shared'] })]);

    const r = await applyTemplateEntries(['fresh']);
    expect(r.added).toEqual([]);
    expect(r.skipped[0]?.reason).toContain('match key');
  });
});

describe('addAppsToTemplate / removeTemplateEntries', () => {
  test('tokenizes a registry app into the template, then removes it', async () => {
    const underHome = join(homedir(), '.rubato-test-app');
    await saveApps([asApp({ name: 'mine', absolutePath: underHome, aliases: ['m'], managed: true })]);

    const r = await addAppsToTemplate(['mine']);
    expect(r.added).toEqual(['mine']);
    const entry = (await loadTemplate()).find((e) => e.name === 'mine');
    expect(entry?.absolutePath).toBe('<HOME>/.rubato-test-app');
    expect(entry?.aliases).toEqual(['m']);
    expect(entry?.managed).toBeUndefined(); // derived field stripped

    const rem = await removeTemplateEntries(['mine']);
    expect(rem.removed).toEqual(['mine']);
    expect((await loadTemplate()).find((e) => e.name === 'mine')).toBeUndefined();
  });

  test('re-adding an app upserts its entry in place (no duplicate)', async () => {
    await saveTemplate([{ name: 'mine', absolutePath: '<HOME>/old' }]);
    await saveApps([asApp({ name: 'mine', absolutePath: join(homedir(), 'new') })]);

    await addAppsToTemplate(['mine']);
    const entries = (await loadTemplate()).filter((e) => e.name === 'mine');
    expect(entries).toHaveLength(1);
    expect(entries[0].absolutePath).toBe('<HOME>/new');
  });
});

describe('templateGitStatus / commitTemplate', () => {
  test('tracks dirty state and commits ONLY the template file', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'rubato-tpl-git-'));
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 't@t.test']);
    await git(repo, ['config', 'user.name', 'Test']);
    // An unrelated staged change that must survive a template commit.
    await writeFile(join(repo, 'other.txt'), 'unrelated');
    await git(repo, ['add', 'other.txt']);

    process.env.RUBATO_APPS_TEMPLATE = join(repo, 'apps.template.json');
    await saveTemplate([{ name: 'zshrc', absolutePath: '<HOME>/.zshrc' }]);

    expect(await templateGitStatus()).toEqual({ inRepo: true, state: 'untracked', dirty: true });

    const c = await commitTemplate('test: add template');
    expect(c.ok).toBe(true);
    expect(c.committed).toBe(true);
    expect(await templateGitStatus()).toEqual({ inRepo: true, state: 'clean', dirty: false });

    // the unrelated staged file was NOT swept into the template commit
    const st = await git(repo, ['status', '--porcelain', '--', 'other.txt']);
    expect(st.stdout.trim().startsWith('A')).toBe(true);

    // editing the template marks it modified; committing twice no-ops the second
    await saveTemplate([
      { name: 'zshrc', absolutePath: '<HOME>/.zshrc' },
      { name: 'cfg', absolutePath: '<HOME>/.rubato/apps.json' },
    ]);
    expect((await templateGitStatus()).state).toBe('modified');
    expect((await commitTemplate()).committed).toBe(true);
    expect(await commitTemplate()).toEqual({ ok: true, committed: false, output: 'nothing to commit' });
  });

  test('reports not-in-repo (and refuses commit) outside any git repo', async () => {
    process.env.RUBATO_APPS_TEMPLATE = join(tmp, 'apps.template.json');
    await saveTemplate([{ name: 'x', absolutePath: '<HOME>/x' }]);
    expect(await templateGitStatus()).toEqual({ inRepo: false, state: 'clean', dirty: false });
    const c = await commitTemplate();
    expect(c.ok).toBe(false);
    expect(c.committed).toBe(false);
  });
});

describe('createTemplateEntries', () => {
  test('adds normalized entries, reports missing paths, skips name clashes', async () => {
    const realDir = join(tmp, 'real');
    await mkdir(realDir, { recursive: true });
    await saveTemplate([{ name: 'existing', absolutePath: '<HOME>/x' }]);

    const r = await createTemplateEntries([
      { name: 'real', absolutePath: realDir }, // path exists
      { name: 'ghost', absolutePath: join(tmp, 'nope') }, // path missing → warning
      { name: 'existing', absolutePath: join(tmp, 'dup') }, // name clash → skipped
    ]);

    expect(r.added.sort()).toEqual(['ghost', 'real']);
    expect(r.skipped.map((s) => s.name)).toEqual(['existing']);
    expect(r.missingPaths).toEqual(['ghost']);
    expect((await loadTemplate()).map((e) => e.name).sort()).toEqual(['existing', 'ghost', 'real']);
  });

  test('normalizes ${homedir()} and an under-home absolute path to <HOME>', async () => {
    const underHome = join(homedir(), '.rubato-create-test');
    const r = await createTemplateEntries([
      { name: 'a', absolutePath: '${homedir()}/.zshrc' },
      { name: 'b', absolutePath: underHome },
    ]);
    expect(r.added).toEqual(['a', 'b']);
    const byName = Object.fromEntries((await loadTemplate()).map((e) => [e.name, e.absolutePath]));
    expect(byName.a).toBe('<HOME>/.zshrc');
    expect(byName.b).toBe('<HOME>/.rubato-create-test');
  });

  test('skips an invalid entry with a reason, without aborting the batch', async () => {
    const r = await createTemplateEntries([{ name: 'ok', absolutePath: '<HOME>/ok' }, { aliases: ['x'] }]);
    expect(r.added).toEqual(['ok']);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/name/);
  });
});

describe('editTemplateEntry', () => {
  test('replaces an entry in place and allows a rename', async () => {
    await saveTemplate([
      { name: 'one', absolutePath: '<HOME>/one' },
      { name: 'two', absolutePath: '<HOME>/two' },
    ]);
    const r = await editTemplateEntry('one', { name: 'uno', absolutePath: '${homedir()}/uno', aliases: ['u'] });
    expect(r.ok).toBe(true);
    expect(r.updated).toBe('uno');
    const entries = await loadTemplate();
    expect(entries.map((e) => e.name)).toEqual(['uno', 'two']); // order preserved
    expect(entries[0].absolutePath).toBe('<HOME>/uno');
  });

  test('rejects a rename that collides with a different entry', async () => {
    await saveTemplate([
      { name: 'a', absolutePath: '<HOME>/a' },
      { name: 'b', absolutePath: '<HOME>/b' },
    ]);
    const r = await editTemplateEntry('a', { name: 'B', absolutePath: '<HOME>/a' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already named/);
    expect((await loadTemplate()).map((e) => e.name)).toEqual(['a', 'b']); // unchanged
  });

  test('errors when the original entry is missing', async () => {
    await saveTemplate([{ name: 'a', absolutePath: '<HOME>/a' }]);
    const r = await editTemplateEntry('nope', { name: 'x', absolutePath: '<HOME>/x' });
    expect(r.ok).toBe(false);
  });
});

describe('sortTemplate', () => {
  test('sorts entries alphabetically by name (case-insensitive) and persists', async () => {
    await saveTemplate([
      { name: 'Zed', absolutePath: '<HOME>/z' },
      { name: 'apple', absolutePath: '<HOME>/a' },
      { name: 'Mango', absolutePath: '<HOME>/m' },
    ]);
    const r = await sortTemplate();
    expect(r.template.map((e) => e.name)).toEqual(['apple', 'Mango', 'Zed']);
    expect((await loadTemplate()).map((e) => e.name)).toEqual(['apple', 'Mango', 'Zed']);
  });
});

describe('hidden templates (per-machine)', () => {
  test('set + read the hidden set, de-duplicated; surfaced by getTemplateStatus', async () => {
    await saveTemplate([{ name: 'a', absolutePath: '<HOME>/a' }]);
    const r = await setHiddenTemplates(['a', 'a', 'b']);
    expect(r.hidden).toEqual(['a', 'b']);
    expect(await getHiddenTemplates()).toEqual(['a', 'b']);
    expect((await getTemplateStatus()).hidden).toEqual(['a', 'b']);

    // An empty list clears it (restore all).
    expect((await setHiddenTemplates([])).hidden).toEqual([]);
    expect(await getHiddenTemplates()).toEqual([]);
  });
});

describe('templateDiff', () => {
  test('untracked → all-additions diff; modified → diff vs HEAD; clean → empty', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'rubato-tpl-diff-'));
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 't@t.test']);
    await git(repo, ['config', 'user.name', 'Test']);
    process.env.RUBATO_APPS_TEMPLATE = join(repo, 'apps.template.json');

    // Untracked (never committed) → the whole file shows as additions.
    await saveTemplate([{ name: 'zshrc', absolutePath: '<HOME>/.zshrc' }]);
    const untracked = (await templateDiff()).diff;
    expect(untracked).toContain('+');
    expect(untracked).toContain('"name": "zshrc"');
    expect(untracked).toContain('@@ -0,0'); // brand-new file: old side is empty (pure additions)

    // Commit it → clean → no diff to review.
    await commitTemplate('test: add template');
    expect((await templateDiff()).diff).toBe('');

    // Edit it → the diff vs HEAD shows the added entry.
    await saveTemplate([
      { name: 'zshrc', absolutePath: '<HOME>/.zshrc' },
      { name: 'cfg', absolutePath: '<HOME>/.rubato/apps.json' },
    ]);
    const modified = (await templateDiff()).diff;
    expect(modified).toContain('+');
    expect(modified).toContain('"name": "cfg"');
    expect(modified).toContain('@@');
  });

  test('outside a git repo → empty diff (nothing to review)', async () => {
    process.env.RUBATO_APPS_TEMPLATE = join(tmp, 'apps.template.json');
    await saveTemplate([{ name: 'x', absolutePath: '<HOME>/x' }]);
    expect(await templateDiff()).toEqual({ diff: '' });
  });
});
