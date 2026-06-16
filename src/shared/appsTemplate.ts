/**
 * Shared apps-template model — the pure, browser-safe core behind the "save a
 * template apps.json once, apply it on every machine" feature.
 *
 * A **template** is an array of app-registry entries whose paths are written
 * home-relative with the `<HOME>` token (`<HOME>/.zshrc`), so the same list ports
 * across machines with different usernames/home dirs. The file lives in the repo
 * (git-tracked → synced by `git pull`); each machine resolves `<HOME>` to its own
 * home dir, sees which entries are already in its local `~/.rubato/apps.json`, and
 * adds the ones it wants.
 *
 * Pure data/types + string transforms only (no node/bun imports) so the UI can
 * import it via `@shared`. The fs/home-dir wrapper lives in `src/server/appsTemplate.ts`.
 */

import { parseLoose } from 'cwip/json';

/** The token in a template path that stands in for the user's home directory. */
export const HOME_TOKEN = '<HOME>';

/**
 * Registry fields a scan derives per-machine — stripped when an app is saved into
 * the template, since they don't port (and a scan re-derives them on apply).
 */
export const TEMPLATE_DERIVED_KEYS = ['dirName', 'repoName', 'packageJsonName', 'managed', 'missing'] as const;

/**
 * One template entry: the portable subset of a registry app. Shaped like
 * `AppConfig` (name/aliases/group/apis/links/…) but with `absolutePath` written
 * home-relative via `<HOME>`. Extra user metadata is carried through verbatim.
 */
export interface TemplateEntry {
  name: string;
  /** Path with the home dir written as `<HOME>` so it ports across machines. */
  absolutePath: string;
  aliases?: string[];
  group?: string | null;
  [key: string]: unknown;
}

/** A template entry annotated with how it relates to THIS machine's registry + disk. */
export interface TemplateEntryStatus {
  entry: TemplateEntry;
  /** `entry.absolutePath` with `<HOME>` expanded to this machine's home dir. */
  resolvedPath: string;
  /** Already present in the local registry (matched by name, else by resolved path). */
  applied: boolean;
  /** When applied, the registry entry's stored path — to surface drift. */
  appliedPath?: string;
  /** Applied, but the registry path differs from where the template now points. */
  pathMismatch: boolean;
  /** `resolvedPath` currently exists on disk (file or directory). */
  pathExists: boolean;
}

/**
 * Git state of the template file — drives the "commit so other machines can pull"
 * nudge. Computed server-side (needs git); the type lives here for the UI.
 */
export interface TemplateGit {
  /** The template file is inside a git repo, so committing it is possible. */
  inRepo: boolean;
  /** Uncommitted state of the template file relative to HEAD. */
  state: 'clean' | 'modified' | 'untracked';
  /** Convenience: `state !== 'clean'` — there are changes to commit. */
  dirty: boolean;
}

/** The whole template, resolved against the local machine. */
export interface TemplateStatus {
  /** Absolute path of the template file on disk. */
  path: string;
  /** Whether the template file exists yet. */
  exists: boolean;
  /** Git state of the template file (commit nudge). */
  git: TemplateGit;
  entries: TemplateEntryStatus[];
  /** Names of entries hidden on THIS machine (per-machine config, not the file). */
  hidden: string[];
}

/** Join two path segments with exactly one separator (POSIX-style, browser-safe). */
function joinPath(base: string, rest: string): string {
  if (!rest) return base;
  return `${base.replace(/\/+$/, '')}/${rest.replace(/^\/+/, '')}`;
}

/** The last path segment, e.g. `/Users/me/.zshrc` → `.zshrc` (browser-safe basename). */
function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/**
 * Expand a leading `<HOME>` (or `~`) in a template path to `home`. Any other path
 * is returned unchanged, so a hand-written absolute path still works (it just
 * won't port).
 */
export function expandHomeToken(path: string, home: string): string {
  if (path === HOME_TOKEN || path === '~') return home;
  if (path.startsWith(`${HOME_TOKEN}/`)) return joinPath(home, path.slice(HOME_TOKEN.length + 1));
  if (path.startsWith('~/')) return joinPath(home, path.slice(2));
  return path;
}

/**
 * Rewrite an absolute path under `home` to use the `<HOME>` token, so it ports
 * across machines. A path outside the home dir is returned unchanged (it can't be
 * made portable; we keep it as-is rather than dropping it).
 */
export function tokenizeHomePath(path: string, home: string): string {
  if (!home) return path;
  const h = home.replace(/\/+$/, '');
  if (path === h) return HOME_TOKEN;
  if (path.startsWith(`${h}/`)) return `${HOME_TOKEN}/${path.slice(h.length + 1)}`;
  return path;
}

/** True when the absolute path lies outside the home dir (so `<HOME>` can't apply). */
export function isOutsideHome(path: string, home: string): boolean {
  return tokenizeHomePath(path, home) === path && !path.startsWith(HOME_TOKEN);
}

/**
 * Derive a portable template entry from a registry app: drop the per-machine
 * derived fields and tokenize the path with `<HOME>`. Everything else (aliases,
 * group, apis, links, …) is carried through verbatim.
 */
export function toTemplateEntry(app: Record<string, unknown>, home: string): TemplateEntry {
  const entry: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(app)) {
    if ((TEMPLATE_DERIVED_KEYS as readonly string[]).includes(k)) continue;
    entry[k] = v;
  }
  entry.absolutePath = tokenizeHomePath(String(app.absolutePath ?? ''), home);
  return entry as TemplateEntry;
}

/**
 * Turn a template entry into a registry app for THIS machine: resolve `<HOME>`,
 * re-derive `dirName`, and mark it hand-added (`managed: false`) so a later scan
 * leaves it alone (and can fill repoName/packageJsonName if it's a real repo).
 */
export function fromTemplateEntry(entry: TemplateEntry, home: string): Record<string, unknown> {
  const resolved = expandHomeToken(String(entry.absolutePath ?? ''), home);
  const { absolutePath: _omit, ...rest } = entry;
  return { ...rest, absolutePath: resolved, dirName: baseName(resolved), managed: false };
}

/**
 * Compute a template entry's status against the local registry (everything except
 * on-disk existence, which the fs layer fills in). An entry is "applied" when the
 * registry already has an app of the same name (case-insensitive), or failing
 * that, one at the same resolved path.
 */
export function resolveEntryStatus(
  entry: TemplateEntry,
  apps: { name: string; absolutePath: string }[],
  home: string,
): Omit<TemplateEntryStatus, 'pathExists'> {
  const resolvedPath = expandHomeToken(String(entry.absolutePath ?? ''), home);
  const nameLc = entry.name?.toLowerCase?.() ?? '';
  const match = apps.find((a) => a.name?.toLowerCase() === nameLc) ?? apps.find((a) => a.absolutePath === resolvedPath);
  return {
    entry,
    resolvedPath,
    applied: !!match,
    appliedPath: match?.absolutePath,
    pathMismatch: !!match && match.absolutePath !== resolvedPath,
  };
}

// A `${homedir()}` / `${os.homedir()}` template-literal call, tolerating inner
// whitespace. Pasted JS entries write paths as `` `${homedir()}/.zshrc` `` — the
// loose parser keeps that literal, and this rewrites it to the portable `<HOME>`.
const HOMEDIR_CALL = /\$\{\s*(?:os\.)?homedir\(\)\s*\}/g;

/**
 * Recursively rewrite `${homedir()}`/`${os.homedir()}` in any string value to the
 * `<HOME>` token, so a pasted JS object (which the loose parser keeps verbatim)
 * becomes a portable template entry. Non-string values pass through unchanged.
 */
export function normalizeHomedir<T>(value: T): T {
  if (typeof value === 'string') return value.replace(HOMEDIR_CALL, HOME_TOKEN) as T;
  if (Array.isArray(value)) return value.map((v) => normalizeHomedir(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeHomedir(v);
    return out as T;
  }
  return value;
}

/**
 * Validate one parsed object as a {@link TemplateEntry}: require a non-empty
 * `name` + `absolutePath`, and (when present) `aliases: string[]` / `group:
 * string|null`. Extra keys are carried through verbatim. Throws a human-readable
 * error otherwise.
 */
export function validateTemplateEntry(raw: unknown): TemplateEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each entry must be an object.');
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) throw new Error('Each entry needs a non-empty "name".');
  const absolutePath = typeof o.absolutePath === 'string' ? o.absolutePath.trim() : '';
  if (!absolutePath) throw new Error(`Entry "${name}" needs a non-empty "absolutePath".`);
  if (o.aliases !== undefined && (!Array.isArray(o.aliases) || o.aliases.some((a) => typeof a !== 'string')))
    throw new Error(`Entry "${name}": "aliases" must be an array of strings.`);
  if (o.group !== undefined && o.group !== null && typeof o.group !== 'string')
    throw new Error(`Entry "${name}": "group" must be a string or null.`);
  return { ...o, name, absolutePath } as TemplateEntry;
}

export interface ParseTemplateResult {
  ok: boolean;
  /** The parsed + validated entries (present when `ok`). */
  entries?: TemplateEntry[];
  /** A human-readable parse/validation error (present when not `ok`). */
  error?: string;
}

/**
 * Parse pasted text — strict JSON **or** a loose JS object literal / array — into
 * validated template entries. Reuses cwip's tolerant {@link parseLoose} (single
 * quotes, unquoted keys, trailing commas, comments), rewrites `${homedir()}` →
 * `<HOME>`, then validates each object. Accepts a single object or an array.
 */
export function parseTemplateEntries(input: string): ParseTemplateResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'Enter a template object.' };
  const parsed = parseLoose(trimmed);
  if (!parsed.ok) {
    const where = parsed.errorLine ? ` (line ${parsed.errorLine}${parsed.errorCol ? `:${parsed.errorCol}` : ''})` : '';
    return { ok: false, error: `${parsed.error ?? 'Invalid object'}${where}` };
  }
  const normalized = normalizeHomedir(parsed.value);
  const list = Array.isArray(normalized) ? normalized : [normalized];
  try {
    const entries = list.map(validateTemplateEntry);
    if (!entries.length) return { ok: false, error: 'No entries found.' };
    return { ok: true, entries };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid entry' };
  }
}

/** Sort entries alphabetically by name (case-insensitive), returning a new array. */
export function sortTemplateEntries(entries: TemplateEntry[]): TemplateEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
