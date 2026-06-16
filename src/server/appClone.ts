/**
 * Clone-to-location + git config-fill — the final slice of the repo-clone task.
 * Clone a repo to a path and register it, and backfill the git clone URL into
 * appConfigs from each repo's `origin`. All local git (offline-testable against a
 * local source repo); no service creds. A foundation for "update dozens of apps".
 */

import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { type AppConfig, loadApps, saveApps } from '../lib/apps';
import { expandPath } from '../lib/config';
import { cloneRepo, isGitRepo, remoteUrl } from '../lib/git';

export interface CloneResult {
  ok: boolean;
  app?: AppConfig;
  error?: string;
}

/** Clone `url` into `dest` (refusing an existing path) and add it to the registry. */
export async function cloneAndRegister(input: {
  url?: unknown;
  dest?: unknown;
  name?: unknown;
  group?: unknown;
}): Promise<CloneResult> {
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const destRaw = typeof input.dest === 'string' ? input.dest.trim() : '';
  if (!url || !destRaw) return { ok: false, error: 'url and dest are required' };

  const dest = expandPath(destRaw);
  const exists = await stat(dest).then(
    () => true,
    () => false,
  );
  if (exists) return { ok: false, error: `dest already exists: ${dest}` };

  const name = (typeof input.name === 'string' && input.name.trim()) || basename(dest);
  const apps = await loadApps();
  if (apps.some((a) => a.name === name)) return { ok: false, error: `an app named "${name}" already exists` };

  const res = await cloneRepo(url, dest);
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || `git clone exited ${res.code}` };

  const app: AppConfig = {
    name,
    absolutePath: dest,
    dirName: basename(dest),
    group: typeof input.group === 'string' && input.group.trim() ? input.group.trim() : null,
    aliases: [],
    cloneUrl: url,
    managed: false,
  };
  apps.push(app);
  await saveApps(apps);
  return { ok: true, app };
}

export interface FillResult {
  filled: Array<{ name: string; cloneUrl: string }>;
  count: number;
}

/** Backfill `cloneUrl` from each git-repo app's origin remote, where missing. */
export async function fillGitUrls(): Promise<FillResult> {
  const apps = await loadApps();
  const filled: Array<{ name: string; cloneUrl: string }> = [];
  for (const app of apps) {
    if (app.cloneUrl) continue;
    if (!(await isGitRepo(app.absolutePath))) continue;
    const url = await remoteUrl(app.absolutePath);
    if (url) {
      app.cloneUrl = url;
      filled.push({ name: app.name, cloneUrl: url });
    }
  }
  if (filled.length) await saveApps(apps);
  return { filled, count: filled.length };
}
