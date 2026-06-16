/**
 * Datadog client, built on the reusable HTTP client.
 *
 *   const datadog = await datadogFromConfig();
 *   const logs = await datadog.searchLogs({ query: "service:web status:error" });
 *
 * Datadog authenticates with two custom headers (an API key and an application
 * key) rather than a bearer token, so they're set as default headers and the
 * client's auth is left as "none".
 */

import { loadConfig } from '../../lib/config';
import { type ApiClient, createApiClient } from '../client';
import { optionalEnv, requireEnv } from '../env';

export interface DatadogLog {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DatadogMetricSeries {
  metric?: string;
  pointlist?: Array<[number, number]>;
  scope?: string;
  [key: string]: unknown;
}

export interface DatadogClientConfig {
  baseUrl: string;
  apiKey: string;
  appKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface DatadogClient {
  readonly api: ApiClient;
  readonly config: DatadogClientConfig;
  validate(): Promise<boolean>;
  searchLogs(opts: { query: string; from?: string; to?: string; limit?: number }): Promise<DatadogLog[]>;
  queryMetrics(opts: { query: string; from: number; to: number }): Promise<DatadogMetricSeries[]>;
}

export function createDatadogClient(config: DatadogClientConfig): DatadogClient {
  const api = createApiClient({
    name: 'datadog',
    baseUrl: config.baseUrl,
    auth: { type: 'none' },
    defaultHeaders: { 'DD-API-KEY': config.apiKey, 'DD-APPLICATION-KEY': config.appKey },
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  });

  async function validate(): Promise<boolean> {
    return (await api.get<{ valid: boolean }>('api/v1/validate')).data.valid;
  }

  async function searchLogs(opts: {
    query: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<DatadogLog[]> {
    const res = await api.post<{ data: DatadogLog[] }>('api/v2/logs/events/search', {
      filter: { query: opts.query, from: opts.from ?? 'now-15m', to: opts.to ?? 'now' },
      page: { limit: opts.limit ?? 50 },
    });
    return res.data.data;
  }

  async function queryMetrics(opts: { query: string; from: number; to: number }): Promise<DatadogMetricSeries[]> {
    const res = await api.get<{ series: DatadogMetricSeries[] }>('api/v1/query', {
      query: { query: opts.query, from: opts.from, to: opts.to },
    });
    return res.data.series;
  }

  return { api, config, validate, searchLogs, queryMetrics };
}

export async function datadogFromConfig(): Promise<DatadogClient> {
  const cfg = await loadConfig();
  const baseUrl = cfg.datadog?.baseUrl ?? optionalEnv('DATADOG_URL') ?? 'https://api.datadoghq.com';
  return createDatadogClient({
    baseUrl,
    apiKey: requireEnv('DATADOG_API_KEY'),
    appKey: requireEnv('DATADOG_APP_KEY'),
  });
}
