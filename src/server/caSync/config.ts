import os from 'node:os';
import { optionalEnv } from '../../api/env';
import { loadConfig } from '../../lib/config';

/**
 * Resolved settings for the ca → rubato sync. The cursedalchemy base URL + a host
 * identifier come from env (CA_SYNC_URL / CA_SYNC_HOST_ID) or `config.json`'s
 * `caSync` block; the API KEY is env-only (CA_SYNC_API_KEY in ~/.rubato/.env), so
 * a secret never lands in config.json. Sync is enabled only when both a URL and a
 * key are present (and not explicitly disabled).
 */
export interface CaSyncSettings {
  enabled: boolean;
  /** ca origin, no trailing slash, no /api suffix (e.g. https://my-ca.example). */
  url: string | null;
  apiKey: string | null;
  /** Stable id for THIS rubato machine, so ca can attribute multi-host data. */
  hostId: string;
  pullIntervalMs: number;
  pushIntervalMs: number;
}

export async function resolveCaSync(): Promise<CaSyncSettings> {
  const cfg = await loadConfig();
  const c = cfg.caSync ?? {};
  const url = (process.env.CA_SYNC_URL ?? c.url ?? '').trim().replace(/\/+$/, '') || null;
  const apiKey = (optionalEnv('CA_SYNC_API_KEY') ?? '').trim() || null;
  const hostId = (process.env.CA_SYNC_HOST_ID ?? c.hostId ?? os.hostname()).trim();
  const enabled = c.enabled !== false && !!url && !!apiKey;
  return {
    enabled,
    url,
    apiKey,
    hostId,
    pullIntervalMs: Math.max(10, c.pullSeconds ?? 60) * 1000,
    pushIntervalMs: Math.max(10, c.pushSeconds ?? 60) * 1000,
  };
}
