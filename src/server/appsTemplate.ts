/**
 * Server fs layer for the shared apps template (see `src/shared/appsTemplate.ts`
 * for the model + pure transforms). Reads/writes the repo-tracked template file,
 * cross-references it against the local `~/.rubato/apps.json` registry + disk, and
 * applies chosen entries into the registry (resolving `<HOME>` to this machine).
 *
 * The template lives at the repo root (`apps.template.json`) so `git pull` syncs
 * it across machines — that's rubato's cross-machine sync (`~/.rubato/` is
 * per-machine). `RUBATO_APPS_TEMPLATE` overrides the path for tests/sandbox.
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { type AppConfig, loadApps, matchKeys, saveApps } from '../lib/apps';
import { loadConfig, saveConfig } from '../lib/config';
import { fileDiff, git } from '../lib/git';
import { findPackageRoot } from '../lib/pkgPaths';
import {
  expandHomeToken,
  fromTemplateEntry,
  normalizeHomedir,
  resolveEntryStatus,
  sortTemplateEntries,
  type TemplateEntry,
  type TemplateGit,
  type TemplateStatus,
  tokenizeHomePath,
  toTemplateEntry,
  validateTemplateEntry,
} from '../shared/appsTemplate';

const REPO_ROOT = findPackageRoot(import.meta.dir);

/** Where the shared template lives — repo root by default, env-overridable for tests/sandbox. */
export function appsTemplatePath(): string {
  return process.env.RUBATO_APPS_TEMPLATE?.trim() || resolve(REPO_ROOT, 'apps.template.json');
}

/** Does `path` exist on disk right now (file OR directory — apps can be either)? */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load + validate the template. Tolerant like `loadApps`: a missing file is an
 * empty template, and a typo'd/hand-broken file is treated as empty rather than
 * crashing the page. Drops rows missing name/absolutePath.
 */
export async function loadTemplate(): Promise<TemplateEntry[]> {
  let raw: string;
  try {
    raw = await readFile(appsTemplatePath(), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e): e is TemplateEntry =>
      !!e &&
      typeof (e as TemplateEntry).name === 'string' &&
      typeof (e as TemplateEntry).absolutePath === 'string' &&
      (e as TemplateEntry).absolutePath.trim() !== '',
  );
}

/** Persist the template (pretty-printed, trailing newline) so a git diff stays clean. */
export async function saveTemplate(entries: TemplateEntry[]): Promise<void> {
  await Bun.write(appsTemplatePath(), `${JSON.stringify(entries, null, 2)}\n`);
}

/**
 * Is the template file's directory inside a git work tree? Keyed off the file's
 * own dir so it works wherever the template lives (repo root, or an env-overridden
 * path), and false for an installed package / non-repo location.
 */
async function inGitRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/**
 * Git state of the template file — clean / modified / untracked — so the UI can
 * nudge you to commit (and push) edits made through it so other machines pull
 * them. `inRepo: false` when the file isn't under git (no commit affordance).
 *
 * All git ops run with cwd = the file's dir and the bare basename as the pathspec,
 * so they're immune to symlinked paths (e.g. macOS `/var`→`/private/var`) that a
 * repo-root-relative pathspec would mis-resolve.
 */
export async function templateGitStatus(): Promise<TemplateGit> {
  const filePath = appsTemplatePath();
  const dir = dirname(filePath);
  if (!(await inGitRepo(dir))) return { inRepo: false, state: 'clean', dirty: false };
  const res = await git(dir, ['status', '--porcelain', '--', basename(filePath)]);
  const line = res.stdout.split('\n').find((l) => l.trim());
  if (!line) return { inRepo: true, state: 'clean', dirty: false };
  return { inRepo: true, state: line.includes('?') ? 'untracked' : 'modified', dirty: true };
}

/** Result of committing just the template file. */
export interface CommitTemplateResult {
  ok: boolean;
  /** False when there was nothing to commit (already clean). */
  committed: boolean;
  /** Trimmed git output (the commit summary), for surfacing what happened. */
  output?: string;
  error?: string;
}

/**
 * Commit ONLY the template file (pathspec-scoped `add` + `commit` run from the
 * file's dir), so unrelated working-tree changes are left untouched. Local only —
 * never pushes; the user pushes to share with other machines.
 */
export async function commitTemplate(message?: string): Promise<CommitTemplateResult> {
  const filePath = appsTemplatePath();
  const dir = dirname(filePath);
  const base = basename(filePath);
  if (!(await inGitRepo(dir))) return { ok: false, committed: false, error: 'template file is not in a git repo' };

  const add = await git(dir, ['add', '--', base]);
  if (add.code !== 0) return { ok: false, committed: false, error: add.stderr.trim() || 'git add failed' };

  // `diff --cached --quiet` exits 0 when nothing is staged for this path → no-op.
  const staged = await git(dir, ['diff', '--cached', '--quiet', '--', base]);
  if (staged.code === 0) return { ok: true, committed: false, output: 'nothing to commit' };

  const msg = message?.trim() || 'chore(apps): update apps.template.json';
  const commit = await git(dir, ['commit', '-m', msg, '--', base]);
  if (commit.code !== 0) return { ok: false, committed: false, error: commit.stderr.trim() || 'git commit failed' };
  return { ok: true, committed: true, output: commit.stdout.trim() || undefined };
}

/** The unified diff of the template file vs its committed state. */
export interface TemplateDiff {
  /** Raw `git diff` text — empty when the file is clean or isn't in a git repo. */
  diff: string;
}

/**
 * The unified diff of the template file against its last commit, so the UI can
 * show exactly what a commit would record (review-before-commit). A tracked edit
 * diffs against HEAD (staged + unstaged together); a never-committed (untracked)
 * template is shown as an all-additions diff. Empty when there's nothing to review
 * (clean) or the file isn't under git. Reuses the same scoping as the other
 * template git ops (cwd = file's dir, bare basename as the path).
 */
export async function templateDiff(): Promise<TemplateDiff> {
  const filePath = appsTemplatePath();
  const gitState = await templateGitStatus();
  if (!gitState.inRepo || !gitState.dirty) return { diff: '' };
  const diff = await fileDiff(dirname(filePath), basename(filePath), {
    untracked: gitState.state === 'untracked',
  });
  return { diff };
}

/**
 * The whole template, resolved against THIS machine: each entry annotated with
 * its resolved path, whether it's already applied (in the registry), any path
 * drift, and whether the path exists on disk — plus the file's git state.
 */
export async function getTemplateStatus(): Promise<TemplateStatus> {
  const path = appsTemplatePath();
  const [exists, gitState, entries, apps, hidden] = await Promise.all([
    pathExists(path),
    templateGitStatus(),
    loadTemplate(),
    loadApps(),
    getHiddenTemplates(),
  ]);
  const home = homedir();
  const lite = apps.map((a) => ({ name: a.name, absolutePath: a.absolutePath }));
  const statuses = await Promise.all(
    entries.map(async (entry) => {
      const base = resolveEntryStatus(entry, lite, home);
      return { ...base, pathExists: await pathExists(base.resolvedPath) };
    }),
  );
  return { path, exists, git: gitState, entries: statuses, hidden };
}

/** Rewrite a path to portable `<HOME>` form: expand `<HOME>`/`~`/absolute against
 *  this machine's home, then tokenize the home prefix back to `<HOME>` (paths
 *  outside the home dir are left absolute — they can't be made portable). */
function toPortablePath(p: string, home: string): string {
  return tokenizeHomePath(expandHomeToken(p, home), home);
}

/** Names of template entries hidden on THIS machine (per-machine config). */
export async function getHiddenTemplates(): Promise<string[]> {
  const cfg = await loadConfig();
  const hidden = cfg.ui?.hiddenTemplates;
  return Array.isArray(hidden) ? hidden.filter((n): n is string => typeof n === 'string') : [];
}

/** Set the per-machine hidden-template set (persisted in `~/.rubato/config.json`,
 *  never the git-tracked template). Returns the de-duplicated stored list. */
export async function setHiddenTemplates(names: string[]): Promise<{ hidden: string[] }> {
  const hidden = [...new Set(names.filter((n) => typeof n === 'string'))];
  const cfg = await loadConfig();
  cfg.ui = { ...cfg.ui, hiddenTemplates: hidden };
  await saveConfig(cfg);
  return { hidden };
}

/** Outcome of creating new hand-written template entries. */
export interface CreateTemplateResult {
  /** Entry names added to the template. */
  added: string[];
  /** Entries skipped, with why (name conflict, validation error). */
  skipped: { name: string; reason: string }[];
  /** Names whose resolved path doesn't exist on disk (a warning, never a block). */
  missingPaths: string[];
  /** The resulting template. */
  template: TemplateEntry[];
}

/**
 * Add new hand-authored entries to the template. Each raw object is normalized
 * (`${homedir()}` → `<HOME>`) + validated, its path rewritten to portable form,
 * and skipped if its name already exists (case-insensitive conflict). A missing
 * on-disk path is reported in `missingPaths` but never blocks the add. Only
 * persists when something was added.
 */
export async function createTemplateEntries(rawEntries: unknown): Promise<CreateTemplateResult> {
  const inputs = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
  const home = homedir();
  const entries = await loadTemplate();
  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e] as const));
  const next = entries.slice();
  const added: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const missingPaths: string[] = [];

  for (const raw of inputs) {
    let entry: TemplateEntry;
    try {
      entry = validateTemplateEntry(normalizeHomedir(raw));
    } catch (e) {
      const name = (
        raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string'
          ? (raw as { name: string }).name
          : '(unnamed)'
      ) as string;
      skipped.push({ name, reason: e instanceof Error ? e.message : 'invalid entry' });
      continue;
    }
    if (byName.has(entry.name.toLowerCase())) {
      skipped.push({ name: entry.name, reason: 'already in template' });
      continue;
    }
    entry.absolutePath = toPortablePath(entry.absolutePath, home);
    next.push(entry);
    byName.set(entry.name.toLowerCase(), entry);
    added.push(entry.name);
    if (!(await pathExists(expandHomeToken(entry.absolutePath, home)))) missingPaths.push(entry.name);
  }

  if (added.length) await saveTemplate(next);
  return { added, skipped, missingPaths, template: next };
}

/** Outcome of editing one template entry. */
export interface EditTemplateResult {
  ok: boolean;
  error?: string;
  /** The entry's (possibly renamed) name when the edit succeeded. */
  updated?: string;
  /** Whether the edited entry's resolved path exists on disk (warning only). */
  pathExists?: boolean;
  template: TemplateEntry[];
}

/**
 * Replace the entry named `originalName` with a new (normalized + validated) one,
 * in place. A rename is allowed, but rejected if it would collide with a
 * *different* existing entry. The path is rewritten to portable form; a missing
 * on-disk path comes back as `pathExists:false` (a warning), not an error.
 */
export async function editTemplateEntry(originalName: string, raw: unknown): Promise<EditTemplateResult> {
  const home = homedir();
  const entries = await loadTemplate();
  const idx = entries.findIndex((e) => e.name === originalName);
  if (idx === -1) return { ok: false, error: `no template entry named "${originalName}"`, template: entries };

  let entry: TemplateEntry;
  try {
    entry = validateTemplateEntry(normalizeHomedir(raw));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid entry', template: entries };
  }
  const clash = entries.some((e, i) => i !== idx && e.name.toLowerCase() === entry.name.toLowerCase());
  if (clash) return { ok: false, error: `another entry is already named "${entry.name}"`, template: entries };

  entry.absolutePath = toPortablePath(entry.absolutePath, home);
  const next = entries.slice();
  next[idx] = entry;
  await saveTemplate(next);
  return {
    ok: true,
    updated: entry.name,
    pathExists: await pathExists(expandHomeToken(entry.absolutePath, home)),
    template: next,
  };
}

/** Sort the template's entries alphabetically by name and persist. */
export async function sortTemplate(): Promise<{ template: TemplateEntry[] }> {
  const sorted = sortTemplateEntries(await loadTemplate());
  await saveTemplate(sorted);
  return { template: sorted };
}

/** Outcome of applying template entries into the registry. */
export interface ApplyTemplateResult {
  /** Entry names added to the registry. */
  added: string[];
  /** Entries that were skipped, with why (already present, path/key clash). */
  skipped: { name: string; reason: string }[];
}

/**
 * Add the named template entries to the local registry. Resolves `<HOME>` to this
 * machine's home dir and skips any entry that would collide with an existing app
 * (same name, same resolved path, or a shared match key) — so applying can never
 * produce an ambiguous registry. Only persists when something was actually added.
 */
export async function applyTemplateEntries(names: string[]): Promise<ApplyTemplateResult> {
  const want = new Set(names);
  const [entries, apps] = await Promise.all([loadTemplate(), loadApps()]);
  const home = homedir();

  const takenNames = new Set(apps.map((a) => a.name.toLowerCase()));
  const takenPaths = new Set(apps.map((a) => a.absolutePath));
  const takenKeys = new Set<string>();
  for (const a of apps) for (const k of matchKeys(a)) takenKeys.add(k.toLowerCase());

  const next = apps.slice();
  const added: string[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const entry of entries) {
    if (!want.has(entry.name)) continue;
    if (takenNames.has(entry.name.toLowerCase())) {
      skipped.push({ name: entry.name, reason: 'already in registry' });
      continue;
    }
    const app = fromTemplateEntry(entry, home) as AppConfig;
    if (takenPaths.has(app.absolutePath)) {
      skipped.push({ name: entry.name, reason: `path already registered (${app.absolutePath})` });
      continue;
    }
    const clash = matchKeys(app).find((k) => takenKeys.has(k.toLowerCase()));
    if (clash) {
      skipped.push({ name: entry.name, reason: `match key "${clash}" already in use` });
      continue;
    }
    next.push(app);
    takenNames.add(entry.name.toLowerCase());
    takenPaths.add(app.absolutePath);
    for (const k of matchKeys(app)) takenKeys.add(k.toLowerCase());
    added.push(entry.name);
  }

  if (added.length) await saveApps(next);
  return { added, skipped };
}

/**
 * Save the named registry apps into the template (home-tokenized, derived fields
 * stripped). Upserts by name — re-adding an app refreshes its template entry in
 * place. Returns the names added/updated and the new template.
 */
export async function addAppsToTemplate(names: string[]): Promise<{ added: string[]; template: TemplateEntry[] }> {
  const want = new Set(names);
  const [entries, apps] = await Promise.all([loadTemplate(), loadApps()]);
  const home = homedir();
  const byName = new Map(entries.map((e) => [e.name, e] as const));
  const added: string[] = [];
  for (const app of apps) {
    if (!want.has(app.name)) continue;
    byName.set(app.name, toTemplateEntry(app, home));
    added.push(app.name);
  }
  const template = [...byName.values()];
  if (added.length) await saveTemplate(template);
  return { added, template };
}

/** Remove the named entries from the template. Returns what was removed + the new template. */
export async function removeTemplateEntries(
  names: string[],
): Promise<{ removed: string[]; template: TemplateEntry[] }> {
  const drop = new Set(names);
  const entries = await loadTemplate();
  const template = entries.filter((e) => !drop.has(e.name));
  const removed = entries.filter((e) => drop.has(e.name)).map((e) => e.name);
  if (removed.length) await saveTemplate(template);
  return { removed, template };
}
