/**
 * Splunk search client, built on the reusable HTTP client.
 *
 *   const splunk = await splunkFromConfig();
 *   const { rows } = await splunk.runSearch('index=main error', { earliest: "-1h" });
 *
 * v1 runs a search through Splunk's blocking **export** endpoint
 * (`/services/search/jobs/export`), which streams results back in one request —
 * no job id to poll. The query builder ([queryBuilder.ts]) assembles the search
 * string; this just executes it for users who've configured Splunk keys.
 *
 * Auth is a Splunk bearer token (`Authorization: Bearer <token>`). The base URL
 * is the Splunk REST endpoint (typically the management port, :8089).
 */

import { loadConfig } from '../../lib/config';
import { type ApiClient, createApiClient } from '../client';
import { optionalEnv } from '../env';
import { resolveServiceBase } from '../service';

export interface SplunkClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface SplunkSearchOptions {
  /** Search-window start, Splunk time syntax (e.g. "-24h", "-15m@m"). Default "-24h". */
  earliest?: string;
  /** Search-window end. Default "now". */
  latest?: string;
  /** Max rows to return. Default 100. */
  count?: number;
  /** Caller abort signal. */
  signal?: AbortSignal;
}

export interface SplunkSearchResult {
  /** Field names in first-seen order across the returned rows. */
  fields: string[];
  /** The result rows (each a field→value map). */
  rows: Array<Record<string, unknown>>;
  /** Number of rows returned. */
  count: number;
}

export interface SplunkClient {
  readonly api: ApiClient;
  readonly config: SplunkClientConfig;
  runSearch(query: string, opts?: SplunkSearchOptions): Promise<SplunkSearchResult>;
}

/**
 * Splunk's search endpoint requires the search string to begin with a command —
 * either an explicit `search` or a leading `|`. Built queries start with bare
 * terms (`index=...`), so prepend `search ` unless one is already present.
 */
export function normalizeSearchCommand(query: string): string {
  const q = query.trim();
  if (!q) return q;
  if (q.startsWith('|') || /^search\b/i.test(q)) return q;
  return `search ${q}`;
}

/**
 * Parse the export endpoint's newline-delimited JSON (`output_mode=json`): one
 * JSON object per line, the real rows carrying a `result` with `preview:false`.
 * Throws if Splunk reported an ERROR/FATAL message in the stream.
 */
export function parseExportResults(text: string): SplunkSearchResult {
  const rows: Array<Record<string, unknown>> = [];
  const fields: string[] = [];
  const seen = new Set<string>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: {
      result?: Record<string, unknown>;
      preview?: boolean;
      messages?: Array<{ type?: string; text?: string }>;
    };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // skip non-JSON noise
    }
    if (Array.isArray(obj.messages)) {
      const fatal = obj.messages.find((m) => m.type === 'ERROR' || m.type === 'FATAL');
      if (fatal) throw new Error(`Splunk: ${fatal.text ?? 'search error'}`);
    }
    if (obj.result && obj.preview !== true) {
      for (const k of Object.keys(obj.result)) {
        if (!seen.has(k)) {
          seen.add(k);
          fields.push(k);
        }
      }
      rows.push(obj.result);
    }
  }
  return { fields, rows, count: rows.length };
}

export function createSplunkClient(config: SplunkClientConfig): SplunkClient {
  const api = createApiClient({
    name: 'splunk',
    baseUrl: config.baseUrl,
    auth: { type: 'bearer', token: config.token },
    timeoutMs: config.timeoutMs ?? 60_000,
    fetch: config.fetch,
  });

  async function runSearch(query: string, opts: SplunkSearchOptions = {}): Promise<SplunkSearchResult> {
    const body = new URLSearchParams({
      search: normalizeSearchCommand(query),
      output_mode: 'json',
      earliest_time: opts.earliest ?? '-24h',
      latest_time: opts.latest ?? 'now',
      count: String(opts.count ?? 100),
    });
    // responseType "text": the export stream is ndjson, not a single JSON document.
    const res = await api.post<string>('services/search/jobs/export', body, {
      responseType: 'text',
      signal: opts.signal,
    });
    return parseExportResults(res.data);
  }

  return { api, config, runSearch };
}

/** True when a Splunk base URL and token are configured — used to gate the UI's Run button. */
export async function splunkConfigured(): Promise<boolean> {
  const cfg = await loadConfig();
  const baseUrl = cfg.splunk?.baseUrl ?? optionalEnv('SPLUNK_URL');
  return Boolean(baseUrl && optionalEnv('SPLUNK_TOKEN'));
}

export async function splunkFromConfig(): Promise<SplunkClient> {
  const cfg = await loadConfig();
  const { baseUrl, token } = resolveServiceBase({
    service: 'splunk',
    configBaseUrl: cfg.splunk?.baseUrl,
    urlEnv: 'SPLUNK_URL',
    tokenEnv: 'SPLUNK_TOKEN',
  });
  return createSplunkClient({ baseUrl, token });
}
