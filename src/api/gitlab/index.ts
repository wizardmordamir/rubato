/**
 * GitLab client, built on the reusable HTTP client.
 *
 *   const gitlab = await gitlabFromConfig();
 *   const commit = await gitlab.getLatestCommit("team/my-app", { ref: "main" });
 *
 * The project is addressed by its URL-encoded "namespace/name" path, which
 * GitLab accepts in place of a numeric id.
 */

import { memoizeAsync } from 'cwip';
import { loadConfig } from '../../lib/config';
import { type ApiClient, createApiClient } from '../client';
import { resolveServiceBase } from '../service';

export interface GitlabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  default_branch?: string;
  [key: string]: unknown;
}

export interface GitlabCommit {
  id: string;
  short_id: string;
  title: string;
  message?: string;
  author_name?: string;
  created_at?: string;
  web_url?: string;
  [key: string]: unknown;
}

export interface GitlabBranch {
  name: string;
  merged?: boolean;
  protected?: boolean;
  default?: boolean;
  commit?: { id: string; short_id: string };
  [key: string]: unknown;
}

export interface GitlabClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface GitlabClient {
  readonly api: ApiClient;
  readonly config: GitlabClientConfig;
  getProject(project: string): Promise<GitlabProject>;
  getCommits(project: string, opts?: { ref?: string; limit?: number }): Promise<GitlabCommit[]>;
  getLatestCommit(project: string, opts?: { ref?: string }): Promise<GitlabCommit | null>;
  getCommit(project: string, sha: string): Promise<GitlabCommit>;
  getBranches(project: string): Promise<GitlabBranch[]>;
}

/** GitLab addresses projects by URL-encoded path; encode the whole "ns/name". */
export function projectId(project: string): string {
  return encodeURIComponent(project);
}

export function createGitlabClient(config: GitlabClientConfig): GitlabClient {
  const api = createApiClient({
    name: 'gitlab',
    baseUrl: config.baseUrl,
    auth: { type: 'header', name: 'PRIVATE-TOKEN', value: config.token },
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  });

  const base = (project: string) => `api/v4/projects/${projectId(project)}`;

  async function getProject(project: string): Promise<GitlabProject> {
    return (await api.get<GitlabProject>(base(project))).data;
  }

  async function getCommits(project: string, opts: { ref?: string; limit?: number } = {}): Promise<GitlabCommit[]> {
    const res = await api.get<GitlabCommit[]>(`${base(project)}/repository/commits`, {
      query: { ref_name: opts.ref, per_page: opts.limit ?? 20 },
    });
    return res.data;
  }

  async function getLatestCommit(project: string, opts: { ref?: string } = {}): Promise<GitlabCommit | null> {
    return (await getCommits(project, { ref: opts.ref, limit: 1 }))[0] ?? null;
  }

  async function getCommit(project: string, sha: string): Promise<GitlabCommit> {
    return (await api.get<GitlabCommit>(`${base(project)}/repository/commits/${encodeURIComponent(sha)}`)).data;
  }

  async function getBranches(project: string): Promise<GitlabBranch[]> {
    return (await api.get<GitlabBranch[]>(`${base(project)}/repository/branches`, { query: { per_page: 100 } })).data;
  }

  return { api, config, getProject, getCommits, getLatestCommit, getCommit, getBranches };
}

/** Build an uncached client from the resolved config (env-global creds). */
async function gitlabClientFromConfig(): Promise<GitlabClient> {
  const cfg = await loadConfig();
  const { baseUrl, token } = resolveServiceBase({
    service: 'gitlab',
    configBaseUrl: cfg.gitlab?.baseUrl,
    urlEnv: 'GITLAB_URL',
    tokenEnv: 'GITLAB_API_TOKEN',
  });
  return createGitlabClient({ baseUrl, token });
}

// Module-level cached read paths. Project metadata, commits, and branches are
// deploy-enrichment reads that the dashboard auto-refresh and repeated catalog
// runs fire identically; memoizeAsync coalesces concurrent identical reads and
// serves a 2-minute cache. Keyed by project (+opts) — credentials are
// process-global. createGitlabClient stays uncached for the unit tests.
const TTL_MS = 2 * 60_000;
const cachedGetProject = memoizeAsync(async (project: string) => (await gitlabClientFromConfig()).getProject(project), {
  key: (project) => project,
  ttlMs: TTL_MS,
});
const cachedGetCommits = memoizeAsync(
  async (project: string, opts: { ref?: string; limit?: number }) =>
    (await gitlabClientFromConfig()).getCommits(project, opts),
  { key: (project, opts) => `${project}|${JSON.stringify(opts ?? {})}`, ttlMs: TTL_MS },
);
const cachedGetBranches = memoizeAsync(
  async (project: string) => (await gitlabClientFromConfig()).getBranches(project),
  { key: (project) => project, ttlMs: TTL_MS },
);

/** Drop the cached project/commit/branch reads (used by the test reset and forced refresh). */
export function clearGitlabCache(): void {
  cachedGetProject.clear();
  cachedGetCommits.clear();
  cachedGetBranches.clear();
}

export async function gitlabFromConfig(): Promise<GitlabClient> {
  const client = await gitlabClientFromConfig();
  // Route reads through the shared cache; getCommit (a specific immutable sha) stays live.
  return {
    ...client,
    getProject: (project) => cachedGetProject(project),
    getCommits: (project, opts = {}) => cachedGetCommits(project, opts),
    getLatestCommit: async (project, opts = {}) =>
      (await cachedGetCommits(project, { ref: opts.ref, limit: 1 }))[0] ?? null,
    getBranches: (project) => cachedGetBranches(project),
  };
}
