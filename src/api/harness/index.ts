/**
 * Harness (NG API) client, built on the reusable HTTP client.
 *
 *   const harness = await harnessFromConfig();
 *   const pipelines = await harness.listPipelines({ org: "default", project: "demo" });
 *
 * Every request carries the account identifier as the `accountIdentifier` query
 * param and authenticates with the `x-api-key` header. Org/project map to
 * Harness's `orgIdentifier`/`projectIdentifier`.
 */

import { loadConfig } from '../../lib/config';
import { type ApiClient, createApiClient } from '../client';
import { optionalEnv, requireEnv } from '../env';

export interface HarnessPipeline {
  identifier: string;
  name: string;
  [key: string]: unknown;
}

export interface HarnessExecution {
  identifier: string;
  name: string;
  [key: string]: unknown;
}

export interface HarnessService {
  identifier: string;
  name: string;
  [key: string]: unknown;
}

export interface HarnessClientConfig {
  baseUrl: string;
  apiKey: string;
  accountId: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface HarnessClient {
  readonly api: ApiClient;
  readonly config: HarnessClientConfig;
  listPipelines(opts: { org: string; project: string; size?: number }): Promise<HarnessPipeline[]>;
  getExecutions(opts: { org: string; project: string; size?: number }): Promise<HarnessExecution[]>;
  getServices(opts: { org: string; project: string }): Promise<HarnessService[]>;
}

/** A paged Harness response wraps the items in `data.content`. */
interface PagedResponse<T> {
  data?: { content?: T[] };
}

export function createHarnessClient(config: HarnessClientConfig): HarnessClient {
  const api = createApiClient({
    name: 'harness',
    baseUrl: config.baseUrl,
    auth: { type: 'header', name: 'x-api-key', value: config.apiKey },
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  });

  /** Merge the always-required account identifier into a call's query params. */
  const withAccount = (query: Record<string, string | number | boolean | null | undefined>) => ({
    accountIdentifier: config.accountId,
    ...query,
  });

  async function listPipelines(opts: { org: string; project: string; size?: number }): Promise<HarnessPipeline[]> {
    const res = await api.post<PagedResponse<HarnessPipeline>>(
      'pipeline/api/pipelines/list',
      { filterType: 'PipelineSetup' },
      { query: withAccount({ orgIdentifier: opts.org, projectIdentifier: opts.project, size: opts.size ?? 25 }) },
    );
    return res.data.data?.content ?? [];
  }

  async function getExecutions(opts: { org: string; project: string; size?: number }): Promise<HarnessExecution[]> {
    const res = await api.post<PagedResponse<HarnessExecution>>(
      'pipeline/api/pipelines/execution/summary',
      { filterType: 'PipelineExecution' },
      { query: withAccount({ orgIdentifier: opts.org, projectIdentifier: opts.project, size: opts.size ?? 25 }) },
    );
    return res.data.data?.content ?? [];
  }

  async function getServices(opts: { org: string; project: string }): Promise<HarnessService[]> {
    const res = await api.get<PagedResponse<HarnessService>>('ng/api/servicesV2', {
      query: withAccount({ orgIdentifier: opts.org, projectIdentifier: opts.project }),
    });
    return res.data.data?.content ?? [];
  }

  return { api, config, listPipelines, getExecutions, getServices };
}

export async function harnessFromConfig(): Promise<HarnessClient> {
  const cfg = await loadConfig();
  const baseUrl = cfg.harness?.baseUrl ?? optionalEnv('HARNESS_URL') ?? 'https://app.harness.io';
  const apiKey = requireEnv('HARNESS_API_KEY');
  const accountId = requireEnv('HARNESS_ACCOUNT_ID');
  return createHarnessClient({ baseUrl, apiKey, accountId });
}
