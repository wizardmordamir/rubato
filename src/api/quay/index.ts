/**
 * Quay (container registry) client, built on the reusable HTTP client.
 *
 *   const quay = await quayFromConfig();
 *   const tags = await quay.getTags("myorg/my-app", { onlyActive: true });
 */

import { memoizeAsync } from 'cwip';
import { loadConfig } from '../../lib/config';
import { type ApiClient, createApiClient } from '../client';
import { resolveServiceBase } from '../service';

export interface QuayTag {
  name: string;
  manifest_digest?: string;
  size?: number;
  last_modified?: string;
  start_ts?: number;
  end_ts?: number;
  is_manifest_list?: boolean;
  [key: string]: unknown;
}

export interface QuayClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface GetTagsOptions {
  /** Only currently-active (non-expired) tags. */
  onlyActive?: boolean;
  /** Page size (Quay paginates). Default 100. */
  limit?: number;
  /** Restrict to a specific tag name. */
  tag?: string;
}

/** Quay/Clair security-scan response for a manifest (the standard shape). */
export interface QuaySecurity {
  /** "scanned" | "queued" | "scanning" | "unsupported" | "failed" | ... */
  status: string;
  data?: {
    Layer?: {
      Features?: Array<{
        Name?: string;
        Version?: string;
        Vulnerabilities?: Array<{ Name?: string; Severity?: string; FixedBy?: string; [key: string]: unknown }>;
        [key: string]: unknown;
      }>;
    };
  };
  [key: string]: unknown;
}

export interface QuayClient {
  readonly api: ApiClient;
  readonly config: QuayClientConfig;
  /** Tags for a "namespace/name" repository, newest first. */
  getTags(repository: string, opts?: GetTagsOptions): Promise<QuayTag[]>;
  /** The most recently pushed tag, or null. */
  getLatestTag(repository: string, opts?: GetTagsOptions): Promise<QuayTag | null>;
  /** Tags matching a predicate (e.g. name includes a build number). */
  findTags(repository: string, predicate: (tag: QuayTag) => boolean, opts?: GetTagsOptions): Promise<QuayTag[]>;
  /** The Clair security scan for a manifest digest ("sha256:..."). */
  getSecurity(repository: string, manifestDigest: string): Promise<QuaySecurity>;
}

export function createQuayClient(config: QuayClientConfig): QuayClient {
  const api = createApiClient({
    name: 'quay',
    baseUrl: config.baseUrl,
    auth: { type: 'bearer', token: config.token },
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  });

  async function getTags(repository: string, opts: GetTagsOptions = {}): Promise<QuayTag[]> {
    const res = await api.get<{ tags?: QuayTag[] }>(`api/v1/repository/${repository}/tag/`, {
      query: {
        limit: opts.limit ?? 100,
        onlyActiveTags: opts.onlyActive ?? true,
        specificTag: opts.tag,
      },
    });
    const tags = res.data.tags ?? [];
    return tags.sort((a, b) => (b.start_ts ?? 0) - (a.start_ts ?? 0)); // newest first
  }

  async function getLatestTag(repository: string, opts?: GetTagsOptions): Promise<QuayTag | null> {
    return (await getTags(repository, opts))[0] ?? null;
  }

  async function findTags(
    repository: string,
    predicate: (tag: QuayTag) => boolean,
    opts?: GetTagsOptions,
  ): Promise<QuayTag[]> {
    return (await getTags(repository, opts)).filter(predicate);
  }

  async function getSecurity(repository: string, manifestDigest: string): Promise<QuaySecurity> {
    const res = await api.get<QuaySecurity>(`api/v1/repository/${repository}/manifest/${manifestDigest}/security`, {
      query: { vulnerabilities: true },
    });
    return res.data;
  }

  return { api, config, getTags, getLatestTag, findTags, getSecurity };
}

/** Build an uncached client from the resolved config (env-global creds). */
async function quayClientFromConfig(): Promise<QuayClient> {
  const cfg = await loadConfig();
  const { baseUrl, token } = resolveServiceBase({
    service: 'quay',
    configBaseUrl: cfg.quay?.baseUrl,
    urlEnv: 'QUAY_URL',
    tokenEnv: 'QUAY_API_TOKEN',
  });
  return createQuayClient({ baseUrl, token });
}

// Module-level cached tag read. Deploy metadata (image tags) barely changes
// minute-to-minute, yet the dashboard auto-refresh and repeated service-catalog
// runs fire identical getTags calls. memoizeAsync coalesces concurrent identical
// reads and serves a 2-minute cache so refreshes don't re-hit Quay. Keyed by
// repo+opts (credentials are process-global). createQuayClient stays uncached so
// the injected-fetch unit tests are unaffected.
const TTL_MS = 2 * 60_000;
const cachedGetTags = memoizeAsync(
  async (repository: string, opts: GetTagsOptions) => (await quayClientFromConfig()).getTags(repository, opts),
  { key: (repository, opts) => `${repository}|${JSON.stringify(opts ?? {})}`, ttlMs: TTL_MS },
);

/** Drop the cached tag reads (used by the test reset and any forced refresh). */
export function clearQuayCache(): void {
  cachedGetTags.clear();
}

export async function quayFromConfig(): Promise<QuayClient> {
  const client = await quayClientFromConfig();
  // Route the read paths through the shared cache; getSecurity stays live.
  return {
    ...client,
    getTags: (repository, opts = {}) => cachedGetTags(repository, opts),
    getLatestTag: async (repository, opts) => (await cachedGetTags(repository, opts ?? {}))[0] ?? null,
    findTags: async (repository, predicate, opts) => (await cachedGetTags(repository, opts ?? {})).filter(predicate),
  };
}
