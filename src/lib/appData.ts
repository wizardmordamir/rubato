/**
 * Where an embedding ("friend") app keeps its automation data on disk.
 *
 * Designed for apps that ship as **bun-compiled binaries** run from an arbitrary
 * location on macOS or Windows: the directory is derived from the user's HOME, never
 * from the binary/module path (in a compiled binary that path is read-only/virtual,
 * so writing next to the executable fails). `os.homedir()` is correct on macOS,
 * Windows, and Linux, so a single `~/.<name>` rule works everywhere — simple and
 * collision-resistant, no per-OS special-casing.
 *
 *   const dir = appDataDir("app-output-files");           // ~/.app-output-files
 *   const dir = appDataDir("my-tool", { env: "MY_TOOL_DATA_DIR" });  // env wins if set
 *   automationsPlugin({ storage: createFileAutomationStore(resolve(dir, "automations")) });
 *
 * rubato's own server doesn't use this — it stays under `RUBATO_HOME`. This is for
 * the friend-app shape, where there's no `~/.rubato`.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Expand a leading `~` / `~/` to the user's home directory. */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a per-user data directory for an app, binary-safe and cross-platform.
 *
 * - If `opts.env` names an environment variable that's set, that path wins (absolute
 *   or `~/…`) — the operator's explicit override.
 * - Otherwise: `~/.<appName>` (e.g. `~/.app-output-files`).
 *
 * `appName` is sanitized to a single safe path segment (leading dots/whitespace
 * trimmed, separators replaced), so it can't escape the home directory.
 */
export function appDataDir(appName: string, opts: { env?: string } = {}): string {
  const override = opts.env ? process.env[opts.env]?.trim() : undefined;
  if (override) return expandTilde(override);
  // Keep only safe segment chars, so the name can't introduce a separator or `..`
  // traversal — the result is always a single dot-dir directly under home.
  const safe = appName.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'app-output-files';
  return resolve(homedir(), `.${safe}`);
}
