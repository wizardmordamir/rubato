/**
 * Jenkins client, built on the reusable HTTP client.
 *
 * Low-level methods take a Jenkins URL path (e.g. "job/Deploys/job/svc"); the
 * app-oriented methods (resolveJobPath / triggerDeployment / getLatestBuildForApp)
 * resolve that path from an app's config so callers work in terms of app + env +
 * branch. All field selection uses Jenkins' `tree` query param to keep payloads
 * small and predictable.
 */

import { type ApiClient, createApiClient } from '../client';
import { type BuildFilter, filterBuildsBy } from './filters';
import { parseBranchFromConfigXml, type ResolveJobOptions, resolveJobUrlPath } from './jobs';
import type { JenkinsAppApi, JenkinsArtifact, JenkinsBuild, JenkinsClientConfig, JenkinsJob } from './types';

/** Default `tree` selector for builds: enough to filter by status/branch/commit. */
const BUILDS_TREE =
  'builds[number,url,result,building,timestamp,duration,displayName,fullDisplayName,' +
  'actions[parameters[name,value],lastBuiltRevision[SHA1,branch[name,SHA1]]],' +
  'changeSets[items[commitId,comment,msg,author[fullName]]],' +
  'artifacts[fileName,relativePath,displayPath]]';

const JOB_TREE = 'name,fullName,url,lastBuild[number,url],lastSuccessfulBuild[number,url],lastFailedBuild[number,url]';

const ARTIFACTS_TREE = 'artifacts[fileName,relativePath,displayPath]';

export type BuildSelector = number | 'lastBuild' | 'lastSuccessfulBuild' | 'lastFailedBuild' | 'lastCompletedBuild';

export interface GetBuildsOptions {
  /** Max builds to fetch (Jenkins range {0,N}). Default 30. */
  limit?: number;
  /** Override the `tree` field selector. */
  tree?: string;
}

export interface TriggerResult {
  status: number;
  /** Queue item URL from the Location header, to poll for the started build. */
  queueUrl: string | null;
}

export interface JenkinsClient {
  /** The underlying HTTP client (escape hatch for endpoints not wrapped here). */
  readonly api: ApiClient;
  readonly config: JenkinsClientConfig;

  // --- low-level (take a Jenkins job URL path) ---
  getJob(jobPath: string, opts?: { tree?: string; depth?: number }): Promise<JenkinsJob>;
  getJobConfigXml(jobPath: string): Promise<string>;
  getJobBranch(jobPath: string): Promise<string | null>;
  getBuilds(jobPath: string, opts?: GetBuildsOptions): Promise<JenkinsBuild[]>;
  getBuild(jobPath: string, selector: BuildSelector, opts?: { tree?: string }): Promise<JenkinsBuild>;
  getLatestBuild(jobPath: string, filter?: BuildFilter, opts?: GetBuildsOptions): Promise<JenkinsBuild | null>;
  triggerBuild(jobPath: string, params?: Record<string, string | number | boolean>): Promise<TriggerResult>;
  getArtifacts(jobPath: string, buildNumber: number): Promise<JenkinsArtifact[]>;
  downloadArtifact(
    jobPath: string,
    buildNumber: number,
    relativePath: string,
  ): Promise<ReadableStream<Uint8Array> | null>;

  // --- app-oriented (resolve the job path from app config) ---
  resolveJobPath(app: JenkinsAppApi, opts?: ResolveJobOptions): string;
  triggerDeployment(
    app: JenkinsAppApi,
    opts: { env: string; branch?: string; params?: Record<string, string | number | boolean> },
  ): Promise<TriggerResult>;
  getLatestBuildForApp(
    app: JenkinsAppApi,
    opts: ResolveJobOptions & { filter?: BuildFilter; limit?: number },
  ): Promise<JenkinsBuild | null>;
}

export function createJenkinsClient(config: JenkinsClientConfig): JenkinsClient {
  const api = createApiClient({
    name: 'jenkins',
    baseUrl: config.baseUrl,
    auth: { type: 'basic', username: config.username, password: config.token },
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  });

  // CSRF crumb, fetched once and reused. Modern Jenkins exempts API-token basic
  // auth from CSRF, so this is best-effort: if the issuer is disabled we proceed
  // without a crumb rather than failing.
  let crumbPromise: Promise<Record<string, string>> | null = null;
  function crumbHeaders(): Promise<Record<string, string>> {
    if (!crumbPromise) {
      crumbPromise = api
        .get<{ crumbRequestField: string; crumb: string }>('crumbIssuer/api/json')
        .then((r) => ({ [r.data.crumbRequestField]: r.data.crumb }))
        .catch(() => ({}));
    }
    return crumbPromise;
  }

  async function getJob(jobPath: string, opts: { tree?: string; depth?: number } = {}): Promise<JenkinsJob> {
    const query: Record<string, string | number> = { tree: opts.tree ?? JOB_TREE };
    if (opts.depth !== undefined) query.depth = opts.depth;
    const res = await api.get<JenkinsJob>(`${jobPath}/api/json`, { query });
    return res.data;
  }

  async function getJobConfigXml(jobPath: string): Promise<string> {
    const res = await api.get<string>(`${jobPath}/config.xml`, { responseType: 'text' });
    return res.data;
  }

  async function getJobBranch(jobPath: string): Promise<string | null> {
    return parseBranchFromConfigXml(await getJobConfigXml(jobPath));
  }

  async function getBuilds(jobPath: string, opts: GetBuildsOptions = {}): Promise<JenkinsBuild[]> {
    const limit = opts.limit ?? 30;
    const tree = `${opts.tree ?? BUILDS_TREE}{0,${limit}}`;
    const res = await api.get<{ builds?: JenkinsBuild[] }>(`${jobPath}/api/json`, { query: { tree } });
    return res.data.builds ?? [];
  }

  async function getBuild(
    jobPath: string,
    selector: BuildSelector,
    opts: { tree?: string } = {},
  ): Promise<JenkinsBuild> {
    const seg = typeof selector === 'number' ? String(selector) : selector;
    const res = await api.get<JenkinsBuild>(`${jobPath}/${seg}/api/json`, {
      query: opts.tree ? { tree: opts.tree } : undefined,
    });
    return res.data;
  }

  async function getLatestBuild(
    jobPath: string,
    filter?: BuildFilter,
    opts: GetBuildsOptions = {},
  ): Promise<JenkinsBuild | null> {
    const builds = await getBuilds(jobPath, opts); // Jenkins returns newest-first
    const filtered = filter ? filterBuildsBy(builds, filter) : builds;
    return filtered[0] ?? null;
  }

  async function triggerBuild(
    jobPath: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<TriggerResult> {
    const headers = await crumbHeaders();
    const hasParams = params && Object.keys(params).length > 0;
    const endpoint = `${jobPath}/${hasParams ? 'buildWithParameters' : 'build'}`;
    const query = hasParams ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) : undefined;
    const res = await api.post(endpoint, undefined, { headers, query });
    return { status: res.status, queueUrl: res.headers.get('location') };
  }

  async function getArtifacts(jobPath: string, buildNumber: number): Promise<JenkinsArtifact[]> {
    const res = await api.get<{ artifacts?: JenkinsArtifact[] }>(`${jobPath}/${buildNumber}/api/json`, {
      query: { tree: ARTIFACTS_TREE },
    });
    return res.data.artifacts ?? [];
  }

  async function downloadArtifact(
    jobPath: string,
    buildNumber: number,
    relativePath: string,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const res = await api.get<ReadableStream<Uint8Array> | null>(`${jobPath}/${buildNumber}/artifact/${relativePath}`, {
      responseType: 'stream',
    });
    return res.data;
  }

  function resolveJobPath(app: JenkinsAppApi, opts?: ResolveJobOptions): string {
    return resolveJobUrlPath(app, { defaults: config.defaults, ...opts });
  }

  function triggerDeployment(
    app: JenkinsAppApi,
    opts: { env: string; branch?: string; params?: Record<string, string | number | boolean> },
  ): Promise<TriggerResult> {
    return triggerBuild(resolveJobPath(app, { env: opts.env, branch: opts.branch }), opts.params);
  }

  function getLatestBuildForApp(
    app: JenkinsAppApi,
    opts: ResolveJobOptions & { filter?: BuildFilter; limit?: number },
  ): Promise<JenkinsBuild | null> {
    const { filter, limit, ...resolveOpts } = opts;
    return getLatestBuild(resolveJobPath(app, resolveOpts), filter, { limit });
  }

  return {
    api,
    config,
    getJob,
    getJobConfigXml,
    getJobBranch,
    getBuilds,
    getBuild,
    getLatestBuild,
    triggerBuild,
    getArtifacts,
    downloadArtifact,
    resolveJobPath,
    triggerDeployment,
    getLatestBuildForApp,
  };
}
