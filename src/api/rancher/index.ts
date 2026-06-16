/**
 * Rancher client, built on the reusable HTTP client.
 *
 *   const rancher = await rancherFromConfig();
 *   const clusters = await rancher.getClusters();
 *   const workloads = await rancher.getWorkloads({ projectId: "c-abc:p-xyz" });
 *
 * Targets the Rancher v3 API. List endpoints return a `{ data: [...] }` envelope,
 * which the methods here unwrap so callers get the array directly. Auth is a
 * Rancher bearer API token ("token-xxxxx:yyyyy").
 */

import { loadConfig } from '../../lib/config';
import { type ApiClient, createApiClient } from '../client';
import { resolveServiceBase } from '../service';

/** A Rancher v3 list endpoint wraps its results in `{ data: [...] }`. */
interface RancherList<T> {
  data: T[];
}

export interface RancherCluster {
  id: string;
  name: string;
  state?: string;
  [key: string]: unknown;
}

export interface RancherProject {
  id: string;
  name: string;
  state?: string;
  [key: string]: unknown;
}

export interface RancherNode {
  id: string;
  name: string;
  state?: string;
  [key: string]: unknown;
}

export interface RancherWorkload {
  id: string;
  name: string;
  state?: string;
  [key: string]: unknown;
}

export interface RancherClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface RancherClient {
  readonly api: ApiClient;
  readonly config: RancherClientConfig;
  getClusters(): Promise<RancherCluster[]>;
  getProjects(): Promise<RancherProject[]>;
  getNodes(opts?: { clusterId?: string }): Promise<RancherNode[]>;
  getWorkloads(opts: { projectId: string }): Promise<RancherWorkload[]>;
}

export function createRancherClient(config: RancherClientConfig): RancherClient {
  const api = createApiClient({
    name: 'rancher',
    baseUrl: config.baseUrl,
    auth: { type: 'bearer', token: config.token },
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  });

  async function getClusters(): Promise<RancherCluster[]> {
    return (await api.get<RancherList<RancherCluster>>('v3/clusters')).data.data;
  }

  async function getProjects(): Promise<RancherProject[]> {
    return (await api.get<RancherList<RancherProject>>('v3/projects')).data.data;
  }

  async function getNodes(opts: { clusterId?: string } = {}): Promise<RancherNode[]> {
    const res = await api.get<RancherList<RancherNode>>('v3/nodes', { query: { clusterId: opts.clusterId } });
    return res.data.data;
  }

  async function getWorkloads(opts: { projectId: string }): Promise<RancherWorkload[]> {
    return (await api.get<RancherList<RancherWorkload>>(`v3/project/${opts.projectId}/workloads`)).data.data;
  }

  return { api, config, getClusters, getProjects, getNodes, getWorkloads };
}

export async function rancherFromConfig(): Promise<RancherClient> {
  const cfg = await loadConfig();
  const { baseUrl, token } = resolveServiceBase({
    service: 'rancher',
    configBaseUrl: cfg.rancher?.baseUrl,
    urlEnv: 'RANCHER_URL',
    tokenEnv: 'RANCHER_TOKEN',
  });
  return createRancherClient({ baseUrl, token });
}
