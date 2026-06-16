/**
 * OpenShift / Kubernetes client, built on the reusable HTTP client.
 *
 *   const oc = await openshiftFromConfig();
 *   const summary = await oc.getPodSummary("my-namespace"); // running/failing/notReady counts
 *   const deploys = await oc.getDeployments("my-namespace"); // image + replicas + deploy time
 *
 * Targets the Kubernetes REST API that OpenShift exposes (the `/api/v1` core +
 * `/apis/apps/v1` groups), so it works against vanilla k8s too. List endpoints
 * return a `{ items: [...] }` envelope, unwrapped here. Auth is a bearer token
 * (an `oc whoami -t` token or a service-account token). The base URL is the
 * cluster API server (e.g. `https://api.cluster.example.com:6443`).
 *
 * This is the API path for "gather OpenShift info on apps" (pipelines use-case 6).
 * When the cluster API server is network-blocked, `openshiftFromConfig` falls back
 * to the web-console PROXY (`<consoleUrl>/api/kubernetes`, console session token) —
 * same client, different base — so pods/events/deployments/logs/yaml still work.
 * A literal browser screen-scrape (if even the console proxy is blocked) is separate.
 */

import { loadConfig } from '../../lib/config';
import { type ApiClient, createApiClient } from '../client';
import { optionalEnv } from '../env';
import { type OpenshiftPod, type PodSummary, type RawPod, type RawPodList, summarizePods } from './summarize';

export * from './summarize';

/** A k8s list endpoint wraps its results in `{ items: [...] }`. */
interface K8sList<T> {
  items: T[];
}

export interface OpenshiftEvent {
  name: string;
  type: string; // "Normal" | "Warning"
  reason: string;
  message: string;
  /** Object the event is about (e.g. "Pod/my-app-abc"). */
  object: string;
  count: number;
  lastSeen?: string;
}

export interface OpenshiftDeployment {
  name: string;
  /** Desired replica count. */
  replicas: number;
  /** Ready / available / updated replicas (rollout health). */
  ready: number;
  available: number;
  updated: number;
  /** Whether the deployment reports itself Available. */
  isAvailable: boolean;
  /** The first container's image (the deployed artifact). */
  image?: string;
  /** Creation timestamp (~ deploy time) and the latest progress update. */
  createdAt?: string;
  updatedAt?: string;
}

export interface OpenshiftClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface GetEventsOptions {
  /** "Warning" to surface only problems; omit for all. */
  type?: string;
  /** Max events to return (most recent first). */
  limit?: number;
}

export interface GetPodLogsOptions {
  /** Container name (required when the pod has more than one). */
  container?: string;
  /** Only the last N lines. */
  tailLines?: number;
  /** Prefix each line with its RFC3339 timestamp. */
  timestamps?: boolean;
  /** Logs from the previous (crashed) container instance instead of the running one. */
  previous?: boolean;
}

export interface OpenshiftClient {
  readonly api: ApiClient;
  readonly config: OpenshiftClientConfig;
  /** Pods in a namespace, normalized (phase, readiness, restarts, problem reason). */
  getPods(namespace: string): Promise<OpenshiftPod[]>;
  /** A roll-up of a namespace's pods (running/failing/notReady counts + problem list). */
  getPodSummary(namespace: string): Promise<PodSummary>;
  /** Events in a namespace (most recent first), optionally only Warnings. */
  getEvents(namespace: string, opts?: GetEventsOptions): Promise<OpenshiftEvent[]>;
  /** Deployments in a namespace (image, replicas, rollout health, deploy time). */
  getDeployments(namespace: string): Promise<OpenshiftDeployment[]>;
  /** One deployment by name. */
  getDeployment(namespace: string, name: string): Promise<OpenshiftDeployment>;
  /** A pod's container logs as plain text (the console "Logs" tab). */
  getPodLogs(namespace: string, pod: string, opts?: GetPodLogsOptions): Promise<string>;
  /** A resource's full manifest — the data behind the console "YAML" tab (kind is a singular like "pod"/"deployment"). */
  getResource(namespace: string, kind: string, name: string): Promise<Record<string, unknown>>;
}

// ── raw k8s shapes (only the fields we read) ─────────────────────────────────

interface RawEvent {
  metadata?: { name?: string };
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  involvedObject?: { kind?: string; name?: string };
}

interface RawDeployment {
  metadata?: { name?: string; creationTimestamp?: string };
  spec?: { replicas?: number; template?: { spec?: { containers?: { name?: string; image?: string }[] } } };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
    conditions?: { type?: string; status?: string; lastUpdateTime?: string }[];
  };
}

function mapEvent(raw: RawEvent): OpenshiftEvent {
  const obj = raw.involvedObject;
  return {
    name: raw.metadata?.name ?? '',
    type: raw.type ?? 'Normal',
    reason: raw.reason ?? '',
    message: (raw.message ?? '').trim(),
    object: obj?.kind && obj.name ? `${obj.kind}/${obj.name}` : (obj?.name ?? ''),
    count: raw.count ?? 1,
    lastSeen: raw.lastTimestamp ?? raw.eventTime,
  };
}

function mapDeployment(raw: RawDeployment): OpenshiftDeployment {
  const status = raw.status ?? {};
  const available = (status.conditions ?? []).find((c) => c.type === 'Available');
  const progressing = (status.conditions ?? []).find((c) => c.type === 'Progressing');
  return {
    name: raw.metadata?.name ?? '',
    replicas: raw.spec?.replicas ?? status.replicas ?? 0,
    ready: status.readyReplicas ?? 0,
    available: status.availableReplicas ?? 0,
    updated: status.updatedReplicas ?? 0,
    isAvailable: available?.status === 'True',
    image: raw.spec?.template?.spec?.containers?.[0]?.image,
    createdAt: raw.metadata?.creationTimestamp,
    updatedAt: progressing?.lastUpdateTime ?? available?.lastUpdateTime,
  };
}

// ── console-proxy fallback + resource paths (pure) ───────────────────────────

/**
 * The OpenShift web console proxies the k8s API at `<consoleUrl>/api/kubernetes`.
 * When the cluster API server is network-blocked but the console (443) is
 * reachable, point the client here with a console session token.
 */
export function consoleApiBase(consoleUrl: string): string {
  return `${consoleUrl.trim().replace(/\/+$/, '')}/api/kubernetes`;
}

/** Core (`/api/v1`) vs apps (`/apis/apps/v1`) resource kinds → their plural path segment. */
const CORE_KINDS: Record<string, string> = {
  pod: 'pods',
  service: 'services',
  configmap: 'configmaps',
  secret: 'secrets',
  event: 'events',
  node: 'nodes',
  persistentvolumeclaim: 'persistentvolumeclaims',
  serviceaccount: 'serviceaccounts',
  replicationcontroller: 'replicationcontrollers',
};
const APPS_KINDS: Record<string, string> = {
  deployment: 'deployments',
  replicaset: 'replicasets',
  statefulset: 'statefulsets',
  daemonset: 'daemonsets',
};

/**
 * Build the namespaced k8s API path for a resource manifest. `kind` is a
 * case-insensitive singular ("pod", "deployment", …). Throws on an unknown kind.
 */
export function resourceApiPath(kind: string, namespace: string, name: string): string {
  const k = kind.trim().toLowerCase().replace(/s$/, '');
  if (CORE_KINDS[k]) return `api/v1/namespaces/${namespace}/${CORE_KINDS[k]}/${name}`;
  if (APPS_KINDS[k]) return `apis/apps/v1/namespaces/${namespace}/${APPS_KINDS[k]}/${name}`;
  throw new Error(
    `Unsupported resource kind "${kind}" (known: ${[...Object.keys(CORE_KINDS), ...Object.keys(APPS_KINDS)].join(', ')})`,
  );
}

export interface OpenshiftBaseInput {
  /** Direct cluster-API server URL (config.openshift.baseUrl or OPENSHIFT_URL). */
  directUrl?: string;
  directToken?: string;
  /** Console base URL (config.openshift.consoleUrl or OPENSHIFT_CONSOLE_URL) — the fallback. */
  consoleUrl?: string;
  consoleToken?: string;
}

/**
 * Pick the transport: the direct cluster API when configured, else the console
 * proxy as a fallback. Throws a clear, actionable error when neither is set (or a
 * URL is set without its token). Pure — `openshiftFromConfig` feeds it config+env.
 */
export function resolveOpenshiftBase(input: OpenshiftBaseInput): {
  baseUrl: string;
  token: string;
  via: 'api' | 'console';
} {
  if (input.directUrl) {
    if (!input.directToken) {
      throw new Error('openshift: OPENSHIFT_URL is set but OPENSHIFT_TOKEN is missing (add it to ~/.rubato/.env).');
    }
    return { baseUrl: input.directUrl, token: input.directToken, via: 'api' };
  }
  if (input.consoleUrl) {
    if (!input.consoleToken) {
      throw new Error(
        'openshift: OPENSHIFT_CONSOLE_URL is set but OPENSHIFT_CONSOLE_TOKEN is missing (the console session token; add it to ~/.rubato/.env).',
      );
    }
    return { baseUrl: consoleApiBase(input.consoleUrl), token: input.consoleToken, via: 'console' };
  }
  throw new Error(
    'openshift: not configured. Set OPENSHIFT_URL (+ OPENSHIFT_TOKEN) for the direct API, ' +
      'or OPENSHIFT_CONSOLE_URL (+ OPENSHIFT_CONSOLE_TOKEN) to fall back through the web console proxy.',
  );
}

export function createOpenshiftClient(config: OpenshiftClientConfig): OpenshiftClient {
  const api = createApiClient({
    name: 'openshift',
    baseUrl: config.baseUrl,
    auth: { type: 'bearer', token: config.token },
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  });

  async function getRawPods(namespace: string): Promise<RawPod[]> {
    const res = await api.get<RawPodList>(`api/v1/namespaces/${namespace}/pods`);
    return res.data.items ?? [];
  }

  async function getPods(namespace: string): Promise<OpenshiftPod[]> {
    return summarizePods(await getRawPods(namespace)).pods;
  }

  async function getPodSummary(namespace: string): Promise<PodSummary> {
    return summarizePods(await getRawPods(namespace));
  }

  async function getEvents(namespace: string, opts: GetEventsOptions = {}): Promise<OpenshiftEvent[]> {
    const res = await api.get<K8sList<RawEvent>>(`api/v1/namespaces/${namespace}/events`, {
      query: { limit: opts.limit },
    });
    let events = (res.data.items ?? []).map(mapEvent);
    if (opts.type) events = events.filter((e) => e.type === opts.type);
    // Most-recent first (k8s returns roughly chronological).
    return events.sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''));
  }

  async function getDeployments(namespace: string): Promise<OpenshiftDeployment[]> {
    const res = await api.get<K8sList<RawDeployment>>(`apis/apps/v1/namespaces/${namespace}/deployments`);
    return (res.data.items ?? []).map(mapDeployment);
  }

  async function getDeployment(namespace: string, name: string): Promise<OpenshiftDeployment> {
    const res = await api.get<RawDeployment>(`apis/apps/v1/namespaces/${namespace}/deployments/${name}`);
    return mapDeployment(res.data);
  }

  async function getPodLogs(namespace: string, pod: string, opts: GetPodLogsOptions = {}): Promise<string> {
    // The /log subresource returns text/plain, not JSON — force text parsing.
    const res = await api.get<string>(`api/v1/namespaces/${namespace}/pods/${pod}/log`, {
      query: {
        container: opts.container,
        tailLines: opts.tailLines,
        timestamps: opts.timestamps ? 'true' : undefined,
        previous: opts.previous ? 'true' : undefined,
      },
      responseType: 'text',
    });
    return res.data;
  }

  async function getResource(namespace: string, kind: string, name: string): Promise<Record<string, unknown>> {
    const res = await api.get<Record<string, unknown>>(resourceApiPath(kind, namespace, name));
    return res.data;
  }

  return {
    api,
    config,
    getPods,
    getPodSummary,
    getEvents,
    getDeployments,
    getDeployment,
    getPodLogs,
    getResource,
  };
}

export async function openshiftFromConfig(): Promise<OpenshiftClient> {
  const cfg = await loadConfig();
  // Direct cluster API first; fall back to the web-console proxy when only the
  // console is reachable (the API server port is commonly firewalled, the
  // console's 443 is not).
  const { baseUrl, token } = resolveOpenshiftBase({
    directUrl: cfg.openshift?.baseUrl ?? optionalEnv('OPENSHIFT_URL'),
    directToken: optionalEnv('OPENSHIFT_TOKEN'),
    consoleUrl: cfg.openshift?.consoleUrl ?? optionalEnv('OPENSHIFT_CONSOLE_URL'),
    consoleToken: optionalEnv('OPENSHIFT_CONSOLE_TOKEN'),
  });
  return createOpenshiftClient({ baseUrl, token });
}
