/**
 * Server fs layer for the Orchestration page (see `src/lib/orchestration/` for the
 * pure parsers/aggregators + `src/shared/orchestration.ts` for the model). Reads
 * the unattended-workflow control files from the agent-workspace directory and
 * exposes an allowlisted view/edit of the config/doc files that drive the loop.
 *
 * **The notes dir is the only configurable path here** (it's machine-specific):
 * `RUBATO_NOTES_DIR` env wins, then config `orchestration.notesDir`, else the
 * derived default `~/code/workspaces/___Agent_Workspace` (the agents' operational
 * folder: TASKS.md, Tasks_Completed.md, orchestration/runs/*.jsonl). Everything the
 * page reads/writes is *inside* that dir, under `~/.claude`, or — for the user's
 * findings note — under the sibling `~/code/workspaces/___Workspace_Notes`. The
 * editable set is a fixed allowlist keyed by a stable `key`, realpath-canonicalized
 * and rejected on traversal, so the client never supplies a path.
 */

import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../lib/config';
import { aggregateStats, emptyTaskBoard, parseHistory, parseRunsJsonl, parseTaskBoard } from '../lib/orchestration';
import type {
  HistoryEntry,
  OrchestrationFileDoc,
  OrchestrationFileInfo,
  OrchestrationOverview,
  RunEntry,
  RunStatus,
} from '../shared/orchestration';

/** A sane cap so an accidental huge paste can't be written to disk. */
const MAX_BYTES = 2_000_000;
/** How many recent runs the live-status view surfaces. */
const RECENT_RUNS = 25;
/** A runs file modified within this window is treated as a live (appending) run. */
const LIVE_WINDOW_MS = 2 * 60_000;

/**
 * Resolve the workspace-notes directory: `RUBATO_NOTES_DIR` env wins, then config
 * `orchestration.notesDir`, else the derived default under the home dir. Async
 * because it consults the config; cheap (config is cached).
 */
export async function notesDir(): Promise<string> {
  const fromEnv = process.env.RUBATO_NOTES_DIR?.trim();
  if (fromEnv) return resolve(expandTilde(fromEnv));
  const cfg = await loadConfig();
  const fromCfg = cfg.orchestration?.notesDir?.trim();
  if (fromCfg) return resolve(expandTilde(fromCfg));
  return defaultNotesDir();
}

/** The derived default notes dir (`~/code/workspaces/___Agent_Workspace`). */
export function defaultNotesDir(): string {
  return resolve(homedir(), 'code', 'workspaces', '___Agent_Workspace');
}

/**
 * Base dir for the user's workspace notes (`~/code/workspaces/___Workspace_Notes`),
 * the sibling of the agent workspace. The findings report — a user-authored note,
 * not an operational control file — lives here, so it stays put even when the notes
 * dir is relocated to the agent workspace.
 */
function workspaceNotesDir(): string {
  return resolve(homedir(), 'code', 'workspaces', '___Workspace_Notes');
}

/** Expand a leading `~` to the home dir (paths in config/env may use it). */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Does `path` exist (file or dir)? */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Read a file's text, or `null` when it doesn't exist (other errors rethrow). */
async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

// ── Control-file reads (parsed via the pure library) ──────────────────────────

/** Parse TASKS.md into a board (empty board when the file is missing). */
async function loadBoard(dir: string) {
  const text = await readMaybe(join(dir, 'TASKS.md'));
  return text === null ? emptyTaskBoard() : parseTaskBoard(text);
}

/** Parse Tasks_Completed.md into history, newest first. */
async function loadHistory(dir: string): Promise<HistoryEntry[]> {
  const text = await readMaybe(join(dir, 'Tasks_Completed.md'));
  if (text === null) return [];
  // The file is roughly newest-first already; sort defensively by start desc.
  return parseHistory(text).sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''));
}

/**
 * Read every `*.jsonl` under `orchestration/runs/`, parse each, and assemble a
 * live-status view. The directory may not exist yet (no run has happened) — that's
 * a clean empty status, not an error.
 */
async function loadRuns(dir: string): Promise<{ runs: RunEntry[]; status: RunStatus }> {
  const runsDir = join(dir, 'orchestration', 'runs');
  let names: string[];
  try {
    names = (await readdir(runsDir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return { runs: [], status: { hasRuns: false, live: false, totalRuns: 0, recent: [] } };
  }
  if (!names.length) return { runs: [], status: { hasRuns: false, live: false, totalRuns: 0, recent: [] } };

  // Read + stat each file; sort by mtime so "latest" + "recent" are time-ordered.
  const files = await Promise.all(
    names.map(async (name) => {
      const path = join(runsDir, name);
      const [text, st] = await Promise.all([readFile(path, 'utf8').catch(() => ''), stat(path)]);
      return { name, text, mtimeMs: st.mtimeMs };
    }),
  );
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const runs: RunEntry[] = [];
  for (const f of files) runs.push(...parseRunsJsonl(f.name, f.text, new Date(f.mtimeMs).toISOString()));

  const latest = files[files.length - 1];
  const now = Date.now();
  const recent = runs.slice(-RECENT_RUNS).reverse();
  const status: RunStatus = {
    hasRuns: runs.length > 0,
    live: now - latest.mtimeMs < LIVE_WINDOW_MS,
    latestFile: latest.name,
    latestModified: new Date(latest.mtimeMs).toISOString(),
    totalRuns: runs.length,
    recent,
  };
  return { runs, status };
}

/** The whole Orchestration page snapshot, in one read. */
export async function getOverview(): Promise<OrchestrationOverview> {
  const dir = await notesDir();
  const dirExists = await exists(dir);
  const [board, history, runsResult] = await Promise.all([loadBoard(dir), loadHistory(dir), loadRuns(dir)]);
  return {
    notesDir: dir,
    notesDirExists: dirExists,
    board,
    history,
    runs: runsResult.status,
    stats: aggregateStats(history, runsResult.runs),
  };
}

// ── Editable config/doc files (allowlist) ─────────────────────────────────────

/** One allowlist entry: a stable key + label + a *derived* (never client-supplied) path. */
interface FileSpec {
  key: string;
  label: string;
  /** Resolved lazily so env/config relocation (notes dir, CLAUDE_CONFIG_DIR) is honored. */
  resolvePath: () => Promise<string> | string;
  markdown?: boolean;
}

/** Base dir of the user's Claude Code config (relocatable for tests). */
function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || resolve(homedir(), '.claude');
}

/**
 * The editable orchestration files, in display order. The agent-workspace control
 * files (TASKS.md, Tasks_Completed.md, the drain-queue script), the user's findings
 * note, and the Claude config + docs (CLAUDE.md, the slash commands, loop.md). Add
 * an entry here to make a file editable — never accept a path from the client.
 * Notes-dir files are resolved against the *current* notes dir, so a relocated/
 * overridden dir is honored; the findings note resolves against the workspace-notes
 * dir, where it lives independent of the (relocatable) notes dir.
 */
const FILE_SPECS: FileSpec[] = [
  {
    key: 'tasks',
    label: 'TASKS.md (live board)',
    resolvePath: () => notesDir().then((d) => join(d, 'TASKS.md')),
    markdown: true,
  },
  {
    key: 'completed',
    label: 'Tasks_Completed.md (history)',
    resolvePath: () => notesDir().then((d) => join(d, 'Tasks_Completed.md')),
    markdown: true,
  },
  {
    key: 'findings',
    label: 'Agent_Workflow_Optimization_Findings.md',
    resolvePath: () => join(workspaceNotesDir(), 'Saved_Instance_Docs', 'Agent_Workflow_Optimization_Findings.md'),
    markdown: true,
  },
  { key: 'claude-md', label: 'Global CLAUDE.md', resolvePath: () => join(claudeDir(), 'CLAUDE.md'), markdown: true },
  { key: 'loop', label: '~/.claude/loop.md', resolvePath: () => join(claudeDir(), 'loop.md'), markdown: true },
  {
    key: 'auto-run-settings',
    label: '~/.claude/auto-run.settings.json',
    resolvePath: () => join(claudeDir(), 'auto-run.settings.json'),
  },
  {
    key: 'next-task',
    label: 'commands/next-task.md',
    resolvePath: () => join(claudeDir(), 'commands', 'next-task.md'),
    markdown: true,
  },
  {
    key: 'drain-queue',
    label: 'orchestration/drain-queue.sh',
    resolvePath: () => notesDir().then((d) => join(d, 'orchestration', 'drain-queue.sh')),
  },
];

/** Look up an allowlist entry by key. */
function specFor(key: string): FileSpec | undefined {
  return FILE_SPECS.find((f) => f.key === key);
}

/** Is `path` a regular file right now? */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Confirm a resolved path is one of the allowlist's *canonical* paths — realpath
 * both sides so a symlink/`..` can't dress an arbitrary path up as an allowed one.
 * For a not-yet-existing file we canonicalize its parent dir instead (so creating
 * `loop.md` still passes) and compare the rejoined path. Returns the safe absolute
 * path, or `null` if it escapes the allowlist.
 */
async function canonicalAllowedPath(spec: FileSpec): Promise<string> {
  const declared = resolve(await spec.resolvePath());
  // Canonicalize as far as the path exists; rejoin the missing tail.
  try {
    return await realpath(declared);
  } catch {
    // File (or some ancestor) doesn't exist yet — canonicalize the nearest dir.
    let dir = dirname(declared);
    const tail: string[] = [declared.slice(dir.length + 1)];
    // Walk up to the first existing ancestor.
    while (!(await exists(dir)) && dir !== dirname(dir)) {
      tail.unshift(dir.slice(dirname(dir).length + 1));
      dir = dirname(dir);
    }
    try {
      const realDir = await realpath(dir);
      return join(realDir, ...tail);
    } catch {
      return declared;
    }
  }
}

/** List the editable orchestration files (path + existence, no content). */
export async function listFiles(): Promise<OrchestrationFileInfo[]> {
  return Promise.all(
    FILE_SPECS.map(async (f) => {
      const path = await canonicalAllowedPath(f);
      return { key: f.key, label: f.label, path, markdown: !!f.markdown, exists: await isFile(path) };
    }),
  );
}

/** Read one editable file (content "" when absent), or `null` for an unknown key. */
export async function readFileDoc(key: string): Promise<OrchestrationFileDoc | null> {
  const spec = specFor(key);
  if (!spec) return null;
  const path = await canonicalAllowedPath(spec);
  try {
    return {
      key: spec.key,
      label: spec.label,
      path,
      markdown: !!spec.markdown,
      exists: true,
      content: await readFile(path, 'utf8'),
    };
  } catch {
    return { key: spec.key, label: spec.label, path, markdown: !!spec.markdown, exists: false, content: '' };
  }
}

/**
 * Write one editable file and return its new state. `null` for an unknown key;
 * throws on a non-string / oversized body. The path is the allowlist's canonical
 * path (never client-supplied), so there is no traversal surface.
 */
export async function writeFileDoc(key: string, content: string): Promise<OrchestrationFileDoc | null> {
  const spec = specFor(key);
  if (!spec) return null;
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error(`content too large (max ${MAX_BYTES} bytes)`);
  const path = await canonicalAllowedPath(spec);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return { key: spec.key, label: spec.label, path, markdown: !!spec.markdown, exists: true, content };
}
