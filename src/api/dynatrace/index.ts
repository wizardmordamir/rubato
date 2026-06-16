/**
 * Dynatrace client, built on the reusable HTTP client.
 *
 *   const dynatrace = await dynatraceFromConfig();
 *   const problems = await dynatrace.getProblems({ from: "now-2h" });
 *
 * Dynatrace authenticates with an API token sent as `Authorization: Api-Token
 * <token>` (not a bearer scheme), and exposes its v2 environment API under
 * `api/v2/*`.
 */

import { loadConfig } from '../../lib/config';
import { type ApiClient, createApiClient } from '../client';
import { resolveServiceBase } from '../service';

export interface DynatraceProblem {
  problemId: string;
  displayId?: string;
  title?: string;
  status?: string;
  severityLevel?: string;
  [key: string]: unknown;
}

export interface DynatraceMetricResult {
  metricId: string;
  data?: unknown[];
  [key: string]: unknown;
}

export interface DynatraceEntity {
  entityId: string;
  displayName?: string;
  type?: string;
  [key: string]: unknown;
}

export interface DynatraceClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface DynatraceClient {
  readonly api: ApiClient;
  readonly config: DynatraceClientConfig;
  getProblems(opts?: { from?: string; pageSize?: number }): Promise<DynatraceProblem[]>;
  queryMetric(opts: { metricSelector: string; from?: string; resolution?: string }): Promise<DynatraceMetricResult[]>;
  getEntities(opts: { entitySelector: string; from?: string; pageSize?: number }): Promise<DynatraceEntity[]>;
}

export function createDynatraceClient(config: DynatraceClientConfig): DynatraceClient {
  const api = createApiClient({
    name: 'dynatrace',
    baseUrl: config.baseUrl,
    auth: { type: 'header', name: 'Authorization', value: `Api-Token ${config.token}` },
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  });

  async function getProblems(opts: { from?: string; pageSize?: number } = {}): Promise<DynatraceProblem[]> {
    const res = await api.get<{ problems: DynatraceProblem[] }>('api/v2/problems', {
      query: { from: opts.from, pageSize: opts.pageSize },
    });
    return res.data.problems;
  }

  async function queryMetric(opts: {
    metricSelector: string;
    from?: string;
    resolution?: string;
  }): Promise<DynatraceMetricResult[]> {
    const res = await api.get<{ result: DynatraceMetricResult[] }>('api/v2/metrics/query', {
      query: { metricSelector: opts.metricSelector, from: opts.from, resolution: opts.resolution },
    });
    return res.data.result;
  }

  async function getEntities(opts: {
    entitySelector: string;
    from?: string;
    pageSize?: number;
  }): Promise<DynatraceEntity[]> {
    const res = await api.get<{ entities: DynatraceEntity[] }>('api/v2/entities', {
      query: { entitySelector: opts.entitySelector, from: opts.from, pageSize: opts.pageSize },
    });
    return res.data.entities;
  }

  return { api, config, getProblems, queryMetric, getEntities };
}

export async function dynatraceFromConfig(): Promise<DynatraceClient> {
  const cfg = await loadConfig();
  const { baseUrl, token } = resolveServiceBase({
    service: 'dynatrace',
    configBaseUrl: cfg.dynatrace?.baseUrl,
    urlEnv: 'DYNATRACE_URL',
    tokenEnv: 'DYNATRACE_API_TOKEN',
  });
  return createDynatraceClient({ baseUrl, token });
}
