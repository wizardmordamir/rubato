/**
 * Cross-app .env discovery + search — GET /api/env-discovery.
 *
 * The per-app editor (`envFiles.ts`) and the side-by-side compare page answer
 * "what's in THIS app's .env". This answers the fleet question: "which apps have
 * (or LACK) a given key/value, by app, group, or across ALL configs that carry
 * `.env*` files". It reuses the same bounded, path-safe discovery + reader as the
 * editor, and — like the agent denylist intent — returns only KEY names, never
 * values, so a one-shot scan across every app can't spill secrets. (Open a file on
 * its app-detail page to see values.)
 */

import { parseEnvText } from 'cwip/env';
import type { AppConfig } from '../lib/apps';
import { loadApps } from '../lib/apps';
import {
  type EnvDiscoveryApp,
  type EnvDiscoveryFile,
  type EnvDiscoveryMode,
  type EnvDiscoveryQuery,
  type EnvDiscoveryResult,
  matchEnvKeys,
} from '../shared/envDiscovery';
import { listAppEnvFiles, readAppEnvFile } from './envFiles';
import { json, jsonError } from './http';

type ScannableApp = Pick<AppConfig, 'name' | 'group' | 'absolutePath'>;

/** Discover/search across a given set of apps (registry-free, so it's unit-testable). */
export async function discoverEnvFromApps(apps: ScannableApp[], query: EnvDiscoveryQuery): Promise<EnvDiscoveryResult> {
  const q = (query.q ?? '').trim();
  const value = (query.value ?? '').trim();
  const mode: EnvDiscoveryMode = query.mode === 'with' || query.mode === 'without' ? query.mode : 'all';
  const groupFilter = (query.group ?? '').trim();
  const searching = q !== '' || value !== '';

  const groups = [...new Set(apps.map((a) => a.group).filter((g): g is string => !!g))].sort((a, b) =>
    a.localeCompare(b),
  );
  const inScope = groupFilter ? apps.filter((a) => (a.group ?? '') === groupFilter) : apps;

  const result: EnvDiscoveryApp[] = [];
  let scannedApps = 0;

  for (const app of inScope) {
    const infos = await listAppEnvFiles(app.absolutePath);
    if (infos.length === 0) continue; // only apps that actually carry .env* files
    scannedApps++;

    const files: EnvDiscoveryFile[] = [];
    for (const info of infos) {
      const read = await readAppEnvFile(app.absolutePath, info.path);
      if (!read.ok) continue;
      const entries = parseEnvText(read.content);
      const keys = Object.keys(entries).sort((a, b) => a.localeCompare(b));
      files.push({
        path: info.path,
        name: info.name,
        keyCount: keys.length,
        keys,
        matchedKeys: searching ? matchEnvKeys(entries, q, value) : [],
      });
    }

    // `with` keeps only files that have a match; `without` keeps only files lacking it.
    let kept = files;
    if (searching && mode === 'with') kept = files.filter((f) => f.matchedKeys.length > 0);
    else if (searching && mode === 'without') kept = files.filter((f) => f.matchedKeys.length === 0);
    if (searching && mode !== 'all' && kept.length === 0) continue;

    result.push({
      name: app.name,
      group: app.group,
      files: kept,
      matched: files.some((f) => f.matchedKeys.length > 0),
    });
  }

  const matchedApps = !searching
    ? scannedApps
    : mode === 'all'
      ? result.filter((a) => a.matched).length
      : result.length;

  return { query: q, value, mode, groups, scannedApps, matchedApps, apps: result };
}

/** Discover/search across every registered app. */
export async function discoverEnv(query: EnvDiscoveryQuery): Promise<EnvDiscoveryResult> {
  return discoverEnvFromApps(await loadApps(), query);
}

export async function handleEnvDiscoveryApi(pathname: string, req: Request): Promise<Response> {
  if (pathname !== '/api/env-discovery') return jsonError(`not found: ${pathname}`, 404);
  if (req.method !== 'GET') return jsonError('use GET', 405);
  const sp = new URL(req.url).searchParams;
  const modeRaw = sp.get('mode');
  const mode: EnvDiscoveryMode = modeRaw === 'with' || modeRaw === 'without' ? modeRaw : 'all';
  const result = await discoverEnv({
    group: sp.get('group') ?? undefined,
    q: sp.get('q') ?? undefined,
    value: sp.get('value') ?? undefined,
    mode,
  });
  return json(result);
}
