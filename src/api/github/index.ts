/**
 * GitHub client, built on the reusable HTTP client.
 *
 *   const github = await githubFromConfig();
 *   const commit = await github.getLatestCommit("owner/my-app", { sha: "main" });
 *
 * Repos are addressed by their "owner/repo" string, passed straight into the
 * path. The base URL defaults to https://api.github.com but can point at a
 * GitHub Enterprise instance via config or the GITHUB_URL env var.
 */

import { loadConfig } from '../../lib/config';
import { type ApiClient, createApiClient } from '../client';
import { optionalEnv } from '../env';
import { resolveServiceBase } from '../service';

export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  default_branch?: string;
  [key: string]: unknown;
}

export interface GithubCommit {
  sha: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: { name?: string; email?: string; date?: string };
  };
  [key: string]: unknown;
}

export interface GithubPullRequest {
  id: number;
  number: number;
  title: string;
  state?: string;
  html_url?: string;
  [key: string]: unknown;
}

export interface GithubWorkflowRun {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  [key: string]: unknown;
}

export interface GithubClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface GithubClient {
  readonly api: ApiClient;
  readonly config: GithubClientConfig;
  getRepo(repo: string): Promise<GithubRepo>;
  getCommits(repo: string, opts?: { sha?: string; perPage?: number }): Promise<GithubCommit[]>;
  getLatestCommit(repo: string, opts?: { sha?: string }): Promise<GithubCommit | null>;
  getPullRequests(
    repo: string,
    opts?: { state?: 'open' | 'closed' | 'all'; perPage?: number },
  ): Promise<GithubPullRequest[]>;
  getWorkflowRuns(repo: string, opts?: { perPage?: number }): Promise<GithubWorkflowRun[]>;
}

export function createGithubClient(config: GithubClientConfig): GithubClient {
  const api = createApiClient({
    name: 'github',
    baseUrl: config.baseUrl,
    auth: { type: 'bearer', token: config.token },
    defaultHeaders: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  });

  async function getRepo(repo: string): Promise<GithubRepo> {
    return (await api.get<GithubRepo>(`repos/${repo}`)).data;
  }

  async function getCommits(repo: string, opts: { sha?: string; perPage?: number } = {}): Promise<GithubCommit[]> {
    const res = await api.get<GithubCommit[]>(`repos/${repo}/commits`, {
      query: { sha: opts.sha, per_page: opts.perPage ?? 20 },
    });
    return res.data;
  }

  async function getLatestCommit(repo: string, opts: { sha?: string } = {}): Promise<GithubCommit | null> {
    return (await getCommits(repo, { sha: opts.sha, perPage: 1 }))[0] ?? null;
  }

  async function getPullRequests(
    repo: string,
    opts: { state?: 'open' | 'closed' | 'all'; perPage?: number } = {},
  ): Promise<GithubPullRequest[]> {
    const res = await api.get<GithubPullRequest[]>(`repos/${repo}/pulls`, {
      query: { state: opts.state ?? 'open', per_page: opts.perPage ?? 20 },
    });
    return res.data;
  }

  async function getWorkflowRuns(repo: string, opts: { perPage?: number } = {}): Promise<GithubWorkflowRun[]> {
    const res = await api.get<{ workflow_runs: GithubWorkflowRun[] }>(`repos/${repo}/actions/runs`, {
      query: { per_page: opts.perPage ?? 20 },
    });
    return res.data.workflow_runs;
  }

  return { api, config, getRepo, getCommits, getLatestCommit, getPullRequests, getWorkflowRuns };
}

export async function githubFromConfig(): Promise<GithubClient> {
  const cfg = await loadConfig();
  const configBaseUrl = cfg.github?.baseUrl ?? optionalEnv('GITHUB_URL') ?? 'https://api.github.com';
  const { baseUrl, token } = resolveServiceBase({
    service: 'github',
    configBaseUrl,
    urlEnv: 'GITHUB_URL',
    tokenEnv: 'GITHUB_TOKEN',
  });
  return createGithubClient({ baseUrl, token });
}
