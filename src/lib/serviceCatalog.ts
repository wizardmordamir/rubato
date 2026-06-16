/**
 * Service catalog — a registry of read operations across rubato's HTTP service
 * clients, so they can be driven from one place (the web "Services" tab and the
 * `svc` CLI) instead of a bespoke surface per service.
 *
 * Each entry says how to tell whether the service is configured, how to connect
 * (its `fromConfig`), and a small set of read operations with their parameters.
 * Adding a service is one entry here; the UI/CLI pick it up automatically.
 *
 * Splunk appears here as a single raw-SPL `runSearch` op, for users who just want
 * to paste a query and get JSON. Its richer per-app query *builder* (templates,
 * `${app}`/`${env}` interpolation, copy-without-creds, tabular results) lives on
 * the dedicated "Splunk" tab. Jenkins (app/deploy-driven, surfaced through the
 * deploy commands) is intentionally not in this generic runner.
 */

import { type DatadogClient, datadogFromConfig } from '../api/datadog';
import { type DynatraceClient, dynatraceFromConfig } from '../api/dynatrace';
import { optionalEnv } from '../api/env';
import { type GithubClient, githubFromConfig } from '../api/github';
import { type GitlabClient, gitlabFromConfig } from '../api/gitlab';
import { type HarnessClient, harnessFromConfig } from '../api/harness';
import { type OpenshiftClient, openshiftFromConfig } from '../api/openshift';
import { type QuayClient, quayFromConfig } from '../api/quay';
import { type RancherClient, rancherFromConfig } from '../api/rancher';
import { type SplunkClient, splunkConfigured, splunkFromConfig } from '../api/splunk';
import type { ServiceInfo, ServiceParamInfo } from '../shared/types';
import { loadConfig, type RubatoConfig } from './config';

/** A parameter an operation accepts (string-typed; coerced in `run`). */
interface CatalogParam extends ServiceParamInfo {}

/** One read operation on a service client. */
interface CatalogOperation {
  key: string;
  label: string;
  params: CatalogParam[];
  /** Call the client method. `client` is the connected client (cast per service). */
  run(client: unknown, params: Record<string, string>): Promise<unknown>;
}

/** A service and its operations. */
interface CatalogService {
  name: string;
  label: string;
  /** Which env keys/URL make it "configured" — shown in the UI when it isn't. */
  envHint: string;
  configured(): Promise<boolean>;
  connect(): Promise<unknown>;
  operations: CatalogOperation[];
}

// ── Param coercion ───────────────────────────────────────────────────────────

/** Empty string → undefined (so optional params fall back to the client default). */
function str(v: string | undefined): string | undefined {
  return v && v.trim() !== '' ? v : undefined;
}

/** Parse a numeric param, or undefined when blank. */
function num(v: string | undefined): number | undefined {
  const s = str(v);
  return s === undefined ? undefined : Number(s);
}

// ── "configured?" helpers ────────────────────────────────────────────────────

/** True when a base URL is set (config block, *_URL env, or a built-in default). */
async function hasBaseUrl(key: keyof RubatoConfig, urlEnv: string, hasDefault = false): Promise<boolean> {
  const cfg = await loadConfig();
  const block = cfg[key] as { baseUrl?: string } | undefined;
  return Boolean(block?.baseUrl || optionalEnv(urlEnv) || hasDefault);
}

/** True when every named secret is present in the environment. */
function hasEnv(...keys: string[]): boolean {
  return keys.every((k) => Boolean(optionalEnv(k)));
}

// ── The catalog ──────────────────────────────────────────────────────────────

export const SERVICE_CATALOG: CatalogService[] = [
  {
    name: 'datadog',
    label: 'Datadog',
    envHint: 'DATADOG_API_KEY + DATADOG_APP_KEY (and optionally DATADOG_URL)',
    configured: async () =>
      (await hasBaseUrl('datadog', 'DATADOG_URL', true)) && hasEnv('DATADOG_API_KEY', 'DATADOG_APP_KEY'),
    connect: () => datadogFromConfig(),
    operations: [
      {
        key: 'searchLogs',
        label: 'Search logs',
        params: [
          { name: 'query', label: 'Query', required: true, placeholder: 'service:my-app status:error' },
          { name: 'from', label: 'From', placeholder: 'now-15m' },
          { name: 'to', label: 'To', placeholder: 'now' },
          { name: 'limit', label: 'Limit', placeholder: '50' },
        ],
        run: (c, p) =>
          (c as DatadogClient).searchLogs({ query: p.query, from: str(p.from), to: str(p.to), limit: num(p.limit) }),
      },
      {
        key: 'queryMetrics',
        label: 'Query metrics',
        params: [
          { name: 'query', label: 'Query', required: true, placeholder: 'avg:system.cpu.user{*}' },
          { name: 'from', label: 'From (unix s)', required: true, placeholder: '1700000000' },
          { name: 'to', label: 'To (unix s)', required: true, placeholder: '1700003600' },
        ],
        run: (c, p) =>
          (c as DatadogClient).queryMetrics({ query: p.query, from: num(p.from) ?? 0, to: num(p.to) ?? 0 }),
      },
      { key: 'validate', label: 'Validate keys', params: [], run: (c) => (c as DatadogClient).validate() },
    ],
  },
  {
    name: 'dynatrace',
    label: 'Dynatrace',
    envHint: 'DYNATRACE_URL + DYNATRACE_API_TOKEN',
    configured: async () => (await hasBaseUrl('dynatrace', 'DYNATRACE_URL')) && hasEnv('DYNATRACE_API_TOKEN'),
    connect: () => dynatraceFromConfig(),
    operations: [
      {
        key: 'getProblems',
        label: 'Get problems',
        params: [
          { name: 'from', label: 'From', placeholder: 'now-2h' },
          { name: 'pageSize', label: 'Page size', placeholder: '50' },
        ],
        run: (c, p) => (c as DynatraceClient).getProblems({ from: str(p.from), pageSize: num(p.pageSize) }),
      },
      {
        key: 'queryMetric',
        label: 'Query metric',
        params: [
          { name: 'metricSelector', label: 'Metric selector', required: true, placeholder: 'builtin:host.cpu.usage' },
          { name: 'from', label: 'From', placeholder: 'now-1h' },
          { name: 'resolution', label: 'Resolution', placeholder: '1m' },
        ],
        run: (c, p) =>
          (c as DynatraceClient).queryMetric({
            metricSelector: p.metricSelector,
            from: str(p.from),
            resolution: str(p.resolution),
          }),
      },
      {
        key: 'getEntities',
        label: 'Get entities',
        params: [
          { name: 'entitySelector', label: 'Entity selector', required: true, placeholder: 'type("HOST")' },
          { name: 'from', label: 'From', placeholder: 'now-1h' },
        ],
        run: (c, p) => (c as DynatraceClient).getEntities({ entitySelector: p.entitySelector, from: str(p.from) }),
      },
    ],
  },
  {
    name: 'github',
    label: 'GitHub',
    envHint: 'GITHUB_TOKEN (and GITHUB_URL for GitHub Enterprise)',
    configured: async () => (await hasBaseUrl('github', 'GITHUB_URL', true)) && hasEnv('GITHUB_TOKEN'),
    connect: () => githubFromConfig(),
    operations: [
      {
        key: 'getRepo',
        label: 'Get repo',
        params: [{ name: 'repo', label: 'Repo (owner/name)', required: true, placeholder: 'owner/my-app' }],
        run: (c, p) => (c as GithubClient).getRepo(p.repo),
      },
      {
        key: 'getCommits',
        label: 'Get commits',
        params: [
          { name: 'repo', label: 'Repo (owner/name)', required: true, placeholder: 'owner/name' },
          { name: 'perPage', label: 'Count', placeholder: '20' },
        ],
        run: (c, p) => (c as GithubClient).getCommits(p.repo, { perPage: num(p.perPage) }),
      },
      {
        key: 'getPullRequests',
        label: 'Get pull requests',
        params: [
          { name: 'repo', label: 'Repo (owner/name)', required: true, placeholder: 'owner/name' },
          { name: 'state', label: 'State (open/closed/all)', placeholder: 'open' },
        ],
        run: (c, p) =>
          (c as GithubClient).getPullRequests(p.repo, { state: str(p.state) as 'open' | 'closed' | 'all' | undefined }),
      },
      {
        key: 'getWorkflowRuns',
        label: 'Get workflow runs',
        params: [{ name: 'repo', label: 'Repo (owner/name)', required: true, placeholder: 'owner/name' }],
        run: (c, p) => (c as GithubClient).getWorkflowRuns(p.repo),
      },
    ],
  },
  {
    name: 'gitlab',
    label: 'GitLab',
    envHint: 'GITLAB_URL + GITLAB_API_TOKEN',
    configured: async () => (await hasBaseUrl('gitlab', 'GITLAB_URL')) && hasEnv('GITLAB_API_TOKEN'),
    connect: () => gitlabFromConfig(),
    operations: [
      {
        key: 'getProject',
        label: 'Get project',
        params: [{ name: 'project', label: 'Project (ns/name)', required: true, placeholder: 'team/my-app' }],
        run: (c, p) => (c as GitlabClient).getProject(p.project),
      },
      {
        key: 'getCommits',
        label: 'Get commits',
        params: [
          { name: 'project', label: 'Project (ns/name)', required: true, placeholder: 'team/my-app' },
          { name: 'ref', label: 'Ref', placeholder: 'main' },
          { name: 'limit', label: 'Count', placeholder: '20' },
        ],
        run: (c, p) => (c as GitlabClient).getCommits(p.project, { ref: str(p.ref), limit: num(p.limit) }),
      },
      {
        key: 'getBranches',
        label: 'Get branches',
        params: [{ name: 'project', label: 'Project (ns/name)', required: true, placeholder: 'team/my-app' }],
        run: (c, p) => (c as GitlabClient).getBranches(p.project),
      },
    ],
  },
  {
    name: 'quay',
    label: 'Quay',
    envHint: 'QUAY_URL + QUAY_API_TOKEN',
    configured: async () => (await hasBaseUrl('quay', 'QUAY_URL')) && hasEnv('QUAY_API_TOKEN'),
    connect: () => quayFromConfig(),
    operations: [
      {
        key: 'getTags',
        label: 'Get tags',
        params: [{ name: 'repository', label: 'Repository (ns/name)', required: true, placeholder: 'team/my-app' }],
        run: (c, p) => (c as QuayClient).getTags(p.repository),
      },
      {
        key: 'getLatestTag',
        label: 'Get latest tag',
        params: [{ name: 'repository', label: 'Repository (ns/name)', required: true, placeholder: 'team/my-app' }],
        run: (c, p) => (c as QuayClient).getLatestTag(p.repository),
      },
    ],
  },
  {
    name: 'rancher',
    label: 'Rancher',
    envHint: 'RANCHER_URL + RANCHER_TOKEN',
    configured: async () => (await hasBaseUrl('rancher', 'RANCHER_URL')) && hasEnv('RANCHER_TOKEN'),
    connect: () => rancherFromConfig(),
    operations: [
      { key: 'getClusters', label: 'Get clusters', params: [], run: (c) => (c as RancherClient).getClusters() },
      { key: 'getProjects', label: 'Get projects', params: [], run: (c) => (c as RancherClient).getProjects() },
      {
        key: 'getNodes',
        label: 'Get nodes',
        params: [{ name: 'clusterId', label: 'Cluster id', placeholder: 'c-abc12' }],
        run: (c, p) => (c as RancherClient).getNodes({ clusterId: str(p.clusterId) }),
      },
      {
        key: 'getWorkloads',
        label: 'Get workloads',
        params: [{ name: 'projectId', label: 'Project id', required: true, placeholder: 'c-abc12:p-xyz34' }],
        run: (c, p) => (c as RancherClient).getWorkloads({ projectId: p.projectId }),
      },
    ],
  },
  {
    name: 'openshift',
    label: 'OpenShift',
    envHint:
      'OPENSHIFT_URL + OPENSHIFT_TOKEN — or, when the API is blocked, OPENSHIFT_CONSOLE_URL + OPENSHIFT_CONSOLE_TOKEN (web-console proxy fallback)',
    // Configured via the direct cluster API OR the console-proxy fallback.
    configured: async () => {
      const cfg = await loadConfig();
      const direct = Boolean(cfg.openshift?.baseUrl || optionalEnv('OPENSHIFT_URL')) && hasEnv('OPENSHIFT_TOKEN');
      const console =
        Boolean(cfg.openshift?.consoleUrl || optionalEnv('OPENSHIFT_CONSOLE_URL')) && hasEnv('OPENSHIFT_CONSOLE_TOKEN');
      return direct || console;
    },
    connect: () => openshiftFromConfig(),
    operations: [
      {
        key: 'getPodSummary',
        label: 'Pod summary',
        params: [{ name: 'namespace', label: 'Namespace', required: true, placeholder: 'my-app-prod' }],
        run: (c, p) => (c as OpenshiftClient).getPodSummary(p.namespace),
      },
      {
        key: 'getPods',
        label: 'Get pods',
        params: [{ name: 'namespace', label: 'Namespace', required: true, placeholder: 'my-app-prod' }],
        run: (c, p) => (c as OpenshiftClient).getPods(p.namespace),
      },
      {
        key: 'getEvents',
        label: 'Get events',
        params: [
          { name: 'namespace', label: 'Namespace', required: true, placeholder: 'my-app-prod' },
          { name: 'type', label: 'Type', placeholder: 'Warning' },
          { name: 'limit', label: 'Limit', placeholder: '50' },
        ],
        run: (c, p) => (c as OpenshiftClient).getEvents(p.namespace, { type: str(p.type), limit: num(p.limit) }),
      },
      {
        key: 'getDeployments',
        label: 'Get deployments',
        params: [{ name: 'namespace', label: 'Namespace', required: true, placeholder: 'my-app-prod' }],
        run: (c, p) => (c as OpenshiftClient).getDeployments(p.namespace),
      },
      {
        key: 'getPodLogs',
        label: 'Pod logs',
        params: [
          { name: 'namespace', label: 'Namespace', required: true, placeholder: 'my-app-prod' },
          { name: 'pod', label: 'Pod', required: true, placeholder: 'web-7c9d-abcde' },
          { name: 'container', label: 'Container', placeholder: 'web' },
          { name: 'tailLines', label: 'Tail lines', placeholder: '200' },
        ],
        run: (c, p) =>
          (c as OpenshiftClient).getPodLogs(p.namespace, p.pod, {
            container: str(p.container),
            tailLines: num(p.tailLines),
          }),
      },
      {
        key: 'getResource',
        label: 'Resource YAML/manifest',
        params: [
          { name: 'namespace', label: 'Namespace', required: true, placeholder: 'my-app-prod' },
          { name: 'kind', label: 'Kind', required: true, placeholder: 'deployment' },
          { name: 'name', label: 'Name', required: true, placeholder: 'web' },
        ],
        run: (c, p) => (c as OpenshiftClient).getResource(p.namespace, p.kind, p.name),
      },
    ],
  },
  {
    name: 'harness',
    label: 'Harness',
    envHint: 'HARNESS_API_KEY + HARNESS_ACCOUNT_ID (and optionally HARNESS_URL)',
    configured: async () =>
      (await hasBaseUrl('harness', 'HARNESS_URL', true)) && hasEnv('HARNESS_API_KEY', 'HARNESS_ACCOUNT_ID'),
    connect: () => harnessFromConfig(),
    operations: [
      {
        key: 'listPipelines',
        label: 'List pipelines',
        params: [
          { name: 'org', label: 'Org identifier', required: true, placeholder: 'default' },
          { name: 'project', label: 'Project identifier', required: true, placeholder: 'my_project' },
        ],
        run: (c, p) => (c as HarnessClient).listPipelines({ org: p.org, project: p.project }),
      },
      {
        key: 'getExecutions',
        label: 'Get executions',
        params: [
          { name: 'org', label: 'Org identifier', required: true, placeholder: 'default' },
          { name: 'project', label: 'Project identifier', required: true, placeholder: 'my_project' },
        ],
        run: (c, p) => (c as HarnessClient).getExecutions({ org: p.org, project: p.project }),
      },
      {
        key: 'getServices',
        label: 'Get services',
        params: [
          { name: 'org', label: 'Org identifier', required: true, placeholder: 'default' },
          { name: 'project', label: 'Project identifier', required: true, placeholder: 'my_project' },
        ],
        run: (c, p) => (c as HarnessClient).getServices({ org: p.org, project: p.project }),
      },
    ],
  },
  {
    name: 'splunk',
    label: 'Splunk',
    envHint: 'SPLUNK_URL + SPLUNK_TOKEN',
    // Same token-auth client the "Splunk" tab's Run button uses; this is just the
    // raw-SPL entry point, no query builder. Build templated queries on that tab.
    configured: () => splunkConfigured(),
    connect: () => splunkFromConfig(),
    operations: [
      {
        key: 'runSearch',
        label: 'Run search (SPL)',
        params: [
          { name: 'query', label: 'Search (SPL)', required: true, placeholder: 'index=main error | head 50' },
          { name: 'earliest', label: 'Earliest', placeholder: '-24h' },
          { name: 'latest', label: 'Latest', placeholder: 'now' },
          { name: 'count', label: 'Count', placeholder: '100' },
        ],
        run: (c, p) =>
          (c as SplunkClient).runSearch(p.query, {
            earliest: str(p.earliest),
            latest: str(p.latest),
            count: num(p.count),
          }),
      },
    ],
  },
];

/** Look up a catalog service by name. */
export function findService(name: string): CatalogService | undefined {
  return SERVICE_CATALOG.find((s) => s.name === name);
}

/** The catalog as plain wire data (configured status resolved), for the UI/CLI. */
export async function listServices(): Promise<ServiceInfo[]> {
  return Promise.all(
    SERVICE_CATALOG.map(async (s) => ({
      name: s.name,
      label: s.label,
      envHint: s.envHint,
      configured: await s.configured().catch(() => false),
      operations: s.operations.map((o) => ({ key: o.key, label: o.label, params: o.params })),
    })),
  );
}

/** Connect to a service and run one of its operations. Throws on unknown service/op. */
export async function runServiceOperation(
  service: string,
  operation: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const svc = findService(service);
  if (!svc) throw new Error(`unknown service: ${service}`);
  const op = svc.operations.find((o) => o.key === operation);
  if (!op) throw new Error(`unknown operation "${operation}" for ${service}`);
  const missing = op.params.filter((pr) => pr.required && !str(params[pr.name])).map((pr) => pr.name);
  if (missing.length) throw new Error(`missing required param(s): ${missing.join(', ')}`);
  const client = await svc.connect();
  return op.run(client, params);
}
