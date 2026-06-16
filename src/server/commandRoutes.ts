/**
 * Saved-commands API. Persists user-authored commands (arbitrary shell lines, or
 * saved invocations of a registry command with preset args) in the shared SQLite
 * db, and runs them on demand — each run lands in the append-only run history.
 *
 *   GET    /api/commands/saved          → SavedCommand[]
 *   POST   /api/commands/saved          → save (create, or update when id given)
 *   DELETE /api/commands/saved/:id      → { deleted }
 *   POST   /api/commands/saved/:id/run  → { run } (runs it; records run history)
 *
 * Note: /api/commands (no trailing segment) is the registry list, handled by the
 * main router — this module only owns /api/commands/saved*.
 */

import { COMMANDS, commandTags } from '../commands';
import { type AppConfig, effectiveAppTags, findAppByPath, findMatches, loadApps } from '../lib/apps';
import { expandPath } from '../lib/config';
import type { SaveCommand, SavedCommand } from '../shared/types';
import { deleteSavedCommand, getCommandStats, getSavedCommand, listSavedCommands, saveSavedCommand } from './db';
import { json, jsonError, readJsonBody } from './http';
import { runSavedCommand } from './run';

/**
 * Tech tags for a saved command: a saved builtin carries the underlying registry
 * command's tags; either kind also picks up the target app's tags, resolved from
 * the working dir (shell) or the first positional arg (builtin).
 */
function savedCommandTags(saved: SavedCommand, apps: AppConfig[]): string[] {
  const tags = new Set<string>();
  if (saved.kind === 'builtin') {
    const cmd = COMMANDS.find((c) => c.name === saved.command);
    for (const t of cmd?.tags ?? commandTags(saved.command) ?? []) tags.add(t);
    const firstArg = saved.args.find((a) => a && !a.startsWith('-'));
    const app = firstArg ? findMatches(firstArg, apps)[0] : undefined;
    if (app) for (const t of effectiveAppTags(app)) tags.add(t);
  } else if (saved.cwd) {
    const app = findAppByPath(expandPath(saved.cwd), apps);
    if (app) for (const t of effectiveAppTags(app)) tags.add(t);
  }
  return [...tags].sort();
}

export async function handleCommandsApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/commands/saved') {
    if (req.method === 'GET') {
      // Merge each saved command's run stats (keyed by its id) for the sorts, and
      // its computed tech tags (underlying builtin + resolved target app).
      const stats = new Map(
        getCommandStats()
          .filter((s) => s.scope === 'saved')
          .map((s) => [s.key, s]),
      );
      const apps = await loadApps();
      return json(
        listSavedCommands().map((c) => ({
          ...c,
          runCount: stats.get(c.id)?.runCount ?? 0,
          lastRunAt: stats.get(c.id)?.lastRunAt,
          tags: savedCommandTags(c, apps),
        })),
      );
    }
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<SaveCommand>(req);
    if (!b) return jsonError('invalid JSON body', 400);
    if (!b.name?.trim()) return jsonError('name required', 400);
    if (b.kind !== 'shell' && b.kind !== 'builtin') return jsonError("kind must be 'shell' or 'builtin'", 400);
    if (!b.command?.trim()) return jsonError('command required', 400);
    if (b.kind === 'builtin' && !COMMANDS.some((c) => c.name === b.command)) {
      return jsonError(`unknown command: ${b.command}`, 400);
    }
    return json(saveSavedCommand(b));
  }

  // /api/commands/saved/:id  and  /api/commands/saved/:id/run
  if (pathname.startsWith('/api/commands/saved/')) {
    const rest = pathname.slice('/api/commands/saved/'.length);
    const isRun = rest.endsWith('/run');
    const id = decodeURIComponent(isRun ? rest.slice(0, -'/run'.length) : rest);
    if (!id) return jsonError('id required', 400);
    if (isRun) {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      const saved = getSavedCommand(id);
      if (!saved) return jsonError(`no saved command: ${id}`, 404);
      try {
        return json({ run: await runSavedCommand(saved) });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : 'run failed', 500);
      }
    }
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    return json({ deleted: deleteSavedCommand(id) });
  }

  return jsonError(`not found: ${pathname}`, 404);
}
