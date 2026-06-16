/**
 * Per-app cross-domain data for the Apps detail page: which systems an app touches
 * (`getAppSources`), and live reads from each applicable one — Jenkins recent builds,
 * the deployed Quay image (version + sha, via the shared collect engine), and the
 * OpenShift runtime (deployments + pod roll-up). Every reader is independently
 * callable, gated by the app's declared `apis`, and resilient: an unconfigured or
 * failing service yields `{ ok:false }`/empty with a soft error, never throws — so
 * the page renders whatever is available and "Refresh all" can fan out safely.
 */

import { clearGitlabCache } from '../api/gitlab';
import {
  buildStatus,
  getBuildBranch,
  getBuildCommits,
  type JenkinsAppApi,
  type JenkinsBuild,
  jenkinsFromConfig,
} from '../api/jenkins';
import { type OpenshiftDeployment, openshiftFromConfig, type PodSummary } from '../api/openshift';
import { clearQuayCache } from '../api/quay';
import type { OpenshiftAppApi } from '../lib/appApis';
import { type AppConfig, getAppApi } from '../lib/apps';
import { buildDeployClients } from '../lib/deploy/clients';
import { collectApp, type DeployClients } from '../lib/deploy/collect';
import { isGitRepo, remoteUrl } from '../lib/git';
import type { AppSources } from '../shared/types';

export async function getAppSources(app: AppConfig): Promise<AppSources> {
  const dir = app.absolutePath;
  const [git, origin] = await Promise.all([isGitRepo(dir), remoteUrl(dir).catch(() => '')]);
  const host = `${origin || ''} ${app.cloneUrl || ''}`.toLowerCase();
  return {
    git,
    jenkins: Boolean(getAppApi(app, 'jenkins')),
    quay: Boolean(getAppApi(app, 'quay')),
    openshift: Boolean(getAppApi(app, 'openshift')),
    gitlab: Boolean(getAppApi(app, 'gitlab')) || host.includes('gitlab'),
    github: host.includes('github'),
  };
}

// ── Jenkins ───────────────────────────────────────────────────────────────────

export interface AppJenkinsBuildRow {
  number: number;
  status: string;
  building: boolean;
  branch: string | null;
  commit: string | null;
  url: string;
  /** Epoch ms. */
  timestamp: number;
  durationMs?: number;
}

export interface AppJenkins {
  ok: boolean;
  jobPath?: string;
  builds: AppJenkinsBuildRow[];
  error?: string;
}

/** Flatten a raw Jenkins build into the row the UI shows. Pure. */
export function toBuildRow(b: JenkinsBuild): AppJenkinsBuildRow {
  return {
    number: b.number,
    status: buildStatus(b),
    building: b.building,
    branch: getBuildBranch(b),
    commit: getBuildCommits(b)[0] ?? null,
    url: b.url,
    timestamp: b.timestamp,
    durationMs: b.duration,
  };
}

/** Recent Jenkins builds for an app's job (env selects the per-env job). */
export async function getAppJenkins(app: AppConfig, opts: { env?: string; limit?: number } = {}): Promise<AppJenkins> {
  const api = getAppApi(app, 'jenkins') as JenkinsAppApi | undefined;
  if (!api) return { ok: false, builds: [], error: 'no jenkins config' };
  try {
    const client = await jenkinsFromConfig();
    const jobPath = client.resolveJobPath(api, { env: opts.env });
    const builds = await client.getBuilds(jobPath, { limit: opts.limit ?? 15 });
    return { ok: true, jobPath, builds: builds.map(toBuildRow) };
  } catch (err) {
    return { ok: false, builds: [], error: (err as Error).message };
  }
}

// ── Deploy (Quay image + Jenkins build join) ───────────────────────────────────

export interface AppDeploy {
  ok: boolean;
  /** False when no Jenkins/Quay client could be built (no creds) — show a hint. */
  configured: boolean;
  version?: string;
  imageSha?: string;
  imageDigest?: string;
  commit?: string;
  buildNumber?: number;
  publishedAt?: string;
  env?: string;
  error?: string;
}

export async function getAppDeploy(app: AppConfig, opts: { env?: string } = {}): Promise<AppDeploy> {
  const clients = await buildDeployClients([app], { jenkins: true, quay: true }).catch(() => ({}) as DeployClients);
  const configured = Boolean(clients.jenkins || clients.quay);
  if (!configured) return { ok: true, configured: false };
  const rec = await collectApp(app, clients, { env: opts.env });
  const ts = rec.jenkins?.build.timestamp;
  return {
    ok: true,
    configured: true,
    version: rec.quay?.version,
    imageSha: rec.quay?.sha256 ?? undefined,
    imageDigest: rec.quay?.tag.manifest_digest ?? undefined,
    commit: rec.jenkins?.commit ?? undefined,
    buildNumber: rec.jenkins?.number,
    publishedAt: typeof ts === 'number' && ts > 0 ? new Date(ts).toISOString() : undefined,
    env: opts.env || undefined,
    error: rec.errors[0],
  };
}

// ── OpenShift ───────────────────────────────────────────────────────────────────

export interface AppOpenshift {
  ok: boolean;
  namespace?: string;
  deployments: OpenshiftDeployment[];
  pods?: PodSummary;
  error?: string;
}

/** The namespace for an app in a given env (per-env override, else the default). */
export function resolveNamespace(api: OpenshiftAppApi, env?: string): string | undefined {
  if (env && api.namespaces?.[env]) return api.namespaces[env];
  return api.namespace ?? (api.namespaces ? Object.values(api.namespaces)[0] : undefined);
}

export async function getAppOpenshift(app: AppConfig, opts: { env?: string } = {}): Promise<AppOpenshift> {
  const api = getAppApi(app, 'openshift') as OpenshiftAppApi | undefined;
  if (!api) return { ok: false, deployments: [], error: 'no openshift config' };
  const ns = resolveNamespace(api, opts.env);
  if (!ns) return { ok: false, deployments: [], error: 'no namespace configured' };
  try {
    const oc = await openshiftFromConfig();
    const [deployments, pods] = await Promise.all([oc.getDeployments(ns), oc.getPodSummary(ns)]);
    return { ok: true, namespace: ns, deployments, pods };
  } catch (err) {
    return { ok: false, namespace: ns, deployments: [], error: (err as Error).message };
  }
}

/** Drop the memoized service reads so a "Refresh all" re-hits the live APIs. */
export function refreshAppCaches(): void {
  clearQuayCache();
  clearGitlabCache();
}
