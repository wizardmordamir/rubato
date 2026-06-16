// Wire types for cross-app .env discovery/search: "find the apps that HAVE (or
// LACK) a given key/value, by app, group, or across all configs with .env* files."
// Values are NEVER carried in these types — only KEY names — so a search response
// can't leak secrets (open a file on its app-detail page to see values).

export type EnvDiscoveryMode = 'all' | 'with' | 'without';

export interface EnvDiscoveryQuery {
  /** Restrict to apps in this group (empty/omitted = every app). */
  group?: string;
  /** Case-insensitive substring matched against KEY names. */
  q?: string;
  /** Optional case-insensitive substring matched against the value of a matching key. */
  value?: string;
  /** `with` = only configs that have a match · `without` = only those lacking it · `all` = list everything. */
  mode?: EnvDiscoveryMode;
}

export interface EnvDiscoveryFile {
  /** Path relative to the app dir (forward-slashed). */
  path: string;
  name: string;
  keyCount: number;
  /** Sorted key names found in the file (no values). */
  keys: string[];
  /** The subset of `keys` matching the query (empty when no query / no match). */
  matchedKeys: string[];
}

export interface EnvDiscoveryApp {
  name: string;
  group: string | null;
  files: EnvDiscoveryFile[];
  /** True when at least one file matched the query (always true when there's no query). */
  matched: boolean;
}

export interface EnvDiscoveryResult {
  /** Echoed query, for the UI. */
  query: string;
  value: string;
  mode: EnvDiscoveryMode;
  /** Distinct non-null groups across scanned apps — drives the group filter. */
  groups: string[];
  /** Apps that have at least one `.env*` file. */
  scannedApps: number;
  /** Of those, how many matched (== scannedApps when there's no query). */
  matchedApps: number;
  apps: EnvDiscoveryApp[];
}

/**
 * The key names in `entries` that match the query — pure, so it's unit-tested and
 * shared by the server scanner. `q` matches the key NAME (substring, case-insensitive);
 * `value` additionally requires that key's value to contain it. An empty query
 * matches nothing (the caller treats that as "no search → list everything").
 */
export function matchEnvKeys(entries: Record<string, string>, q: string, value: string): string[] {
  const qLower = q.trim().toLowerCase();
  const vLower = value.trim().toLowerCase();
  if (!qLower && !vLower) return [];
  return Object.keys(entries)
    .filter((k) => {
      if (qLower && !k.toLowerCase().includes(qLower)) return false;
      if (
        vLower &&
        !String(entries[k] ?? '')
          .toLowerCase()
          .includes(vLower)
      )
        return false;
      return true;
    })
    .sort((a, b) => a.localeCompare(b));
}
