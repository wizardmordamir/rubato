/**
 * Select apps from the registry for multi-app commands. A single optional
 * `filter` narrows to either a group (its containing dir, exact or a parent of
 * nested groups) OR a specific app (by any match key — name/dir/repo/package/
 * alias). Change-making commands also exclude apps that opt out via
 * ignoreCommandTypes. Pure over a given app list so it's easy to test; commands
 * still skip non-repos at runtime via isGitRepo.
 */

import { type AppConfig, type CommandType, ignoresCommand, matchKeys } from './apps';

export interface SelectOptions {
  /** Narrow to a group name or a specific app identifier. Omit for all apps. */
  filter?: string;
  /** A change-making command category; apps that ignore it are excluded. */
  command?: CommandType;
}

/** True if an app's group matches `wanted` exactly or sits under it. */
export function matchesGroup(appGroup: string | null | undefined, wanted: string): boolean {
  if (!appGroup) return false;
  return appGroup === wanted || appGroup.startsWith(`${wanted}/`);
}

/**
 * True if `filter` targets this app — either as a group it belongs to, or as one
 * of its match keys (name/dir/repo/package/alias). Case-insensitive on keys.
 */
export function appMatchesFilter(app: AppConfig, filter: string): boolean {
  if (matchesGroup(app.group, filter)) return true;
  const lower = filter.toLowerCase();
  return matchKeys(app).some((k) => k.toLowerCase() === lower);
}

export function selectApps(apps: AppConfig[], opts: SelectOptions = {}): AppConfig[] {
  return apps.filter((app) => {
    if (app.missing) return false;
    if (opts.filter && !appMatchesFilter(app, opts.filter)) return false;
    if (opts.command && ignoresCommand(app, opts.command)) return false;
    return true;
  });
}
