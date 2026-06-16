/**
 * Orchestrate verification of a parsed deploy list: resolve each entry's app
 * through the registry, bind the live clients into per-entry capabilities scoped
 * to that app, run the pure engine (api/deploy/checks.ts), and aggregate a report.
 *
 * This is the impure seam — registry + config + network — kept thin so the actual
 * checking logic stays pure and unit-tested.
 */

import { type EntryClients, type VerifyContext, verifyEntry } from '../../api/deploy/checks';
import { effectiveVersionStrategy, resolveBuildForVersion, resolveQuayTagForVersion } from '../../api/deploy/resolve';
import type { DeployEntry, VerifyReport, VerifyResult } from '../../api/deploy/types';
import type { GitlabAppApi, JenkinsAppApi, QuayAppApi } from '../appApis';
import { type AppConfig, findMatches, getAppApi } from '../apps';
import { loadConfig } from '../config';
import type { DeployClients } from './collect';

const lastSeg = (s: string) => s.split('/').pop() ?? s;

/**
 * Resolve a deploy-list app label to a registered app. The label is whatever the
 * human wrote (often a Jenkins-ish "ns/name"), so try registry keys (full + last
 * segment), then the configured Quay repository, then the Jenkins project.
 */
export function matchAppForLabel(label: string, apps: AppConfig[]): AppConfig | null {
  for (const key of [label, lastSeg(label)]) {
    const m = findMatches(key, apps);
    if (m.length === 1) return m[0];
  }
  const seg = lastSeg(label);
  const byQuay = apps.filter((a) => {
    const repo = getAppApi(a, 'quay')?.repository;
    return repo === label || (repo && lastSeg(repo) === seg);
  });
  if (byQuay.length === 1) return byQuay[0];
  const byJenkins = apps.filter((a) => {
    const project = getAppApi(a, 'jenkins')?.project;
    return project && lastSeg(project) === seg;
  });
  if (byJenkins.length === 1) return byJenkins[0];
  return null;
}

export interface VerifyListOptions {
  env?: string;
  /** Injectable clock for the verification timestamp. */
  now?: () => number;
}

/** Build the per-entry capabilities scoped to one resolved app. */
async function bindEntryClients(
  app: AppConfig,
  clients: DeployClients,
  opts: VerifyListOptions,
): Promise<EntryClients> {
  const out: EntryClients = {};

  const quayApi = getAppApi(app, 'quay') as QuayAppApi | undefined;
  if (quayApi && clients.quay) {
    out.quayTag = (version) => resolveQuayTagForVersion(clients.quay!, quayApi.repository, version);
  }

  const gitApi = getAppApi(app, 'gitlab') as GitlabAppApi | undefined;
  if (gitApi && clients.gitlab) {
    const project = gitApi.project.includes('/')
      ? gitApi.project
      : gitApi.namespace
        ? `${gitApi.namespace}/${gitApi.project}`
        : gitApi.project;
    out.gitCommit = async (sha) => {
      try {
        const c = await clients.gitlab!.getCommit(project, sha);
        return { message: c.message ?? c.title, author: c.author_name, date: c.created_at };
      } catch (err) {
        // GitLab 404s a missing commit → treat as "does not exist", not a transient error.
        if ((err as { status?: number }).status === 404) return null;
        throw err;
      }
    };
  }

  const jenkinsApi = getAppApi(app, 'jenkins') as JenkinsAppApi | undefined;
  if (jenkinsApi && clients.jenkins) {
    const defaults = (await loadConfig()).jenkins?.defaults;
    const strategy = effectiveVersionStrategy(jenkinsApi, defaults);
    out.jenkinsBuild = async (version) => {
      try {
        const jobPath = clients.jenkins!.resolveJobPath(jenkinsApi, { env: opts.env });
        return await resolveBuildForVersion(clients.jenkins!, jobPath, version, { strategy });
      } catch {
        return { build: null, strategy: 'none' };
      }
    };
  }

  return out;
}

/** Verify every entry and aggregate a report. */
export async function verifyDeployList(
  entries: DeployEntry[],
  apps: AppConfig[],
  clients: DeployClients,
  opts: VerifyListOptions = {},
): Promise<VerifyReport> {
  const results: VerifyResult[] = await Promise.all(
    entries.map(async (entry) => {
      const app = matchAppForLabel(entry.app, apps);
      const ctx: VerifyContext = {
        registryMatched: app !== null,
        clients: app ? await bindEntryClients(app, clients, opts) : {},
        now: opts.now,
      };
      return verifyEntry(entry, ctx);
    }),
  );

  const failed = results.filter((r) => r.status === 'FAIL').length;
  return {
    timestamp: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
    summary: {
      totalEntries: results.length,
      passed: results.length - failed,
      failed,
      totalIssues: results.reduce((n, r) => n + r.issues.length, 0),
      totalWarnings: results.reduce((n, r) => n + r.warnings.length, 0),
    },
    results,
  };
}
