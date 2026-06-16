/**
 * Per-app multi-source join: given an app and whatever clients are configured,
 * gather the latest Jenkins build and Quay image tag (and a label for lists) into
 * one record. This is the single place that knows how to fuse the services, shared
 * by `appall`, `shalist`, and `lastdeploy` so none of them duplicate the gather.
 *
 * Resilient by design: a missing client or a per-service API error is captured in
 * `errors` and leaves that slice blank, never throwing (mirrors appall's old
 * inline behavior).
 */

import type { GitlabClient } from '../../api/gitlab';
import type { JenkinsBuild } from '../../api/jenkins';
import { buildStatus, getBuildBranch, getBuildCommits, type JenkinsClient } from '../../api/jenkins';
import type { QuayClient, QuayTag } from '../../api/quay';
import type { AppApi, JenkinsAppApi, QuayAppApi } from '../appApis';
import { type AppConfig, getAppApi } from '../apps';

export interface DeployClients {
  jenkins?: JenkinsClient | null;
  quay?: QuayClient | null;
  gitlab?: GitlabClient | null;
}

export interface CollectOptions {
  /** Environment to resolve the Jenkins job for (e.g. "prod", "stage"). */
  env?: string;
}

export interface CollectedRecord {
  app: AppConfig;
  /** Name to write into a deploy list — prefers the Quay repo path, else the app name. */
  label: string;
  jenkins?: {
    build: JenkinsBuild;
    number: number;
    status: string;
    branch: string | null;
    commit: string | null;
  };
  quay?: {
    tag: QuayTag;
    version: string;
    /** Image digest, bare lowercase hex (no "sha256:" prefix). */
    sha256: string | null;
  };
  /** Soft per-service errors (service unconfigured or API failure). */
  errors: string[];
}

const asApi = <T extends AppApi>(app: AppConfig, name: T['name']) => getAppApi(app, name) as T | undefined;

/** Strip a leading "sha256:" and lowercase a manifest digest. */
export function bareDigest(digest: string | undefined): string | null {
  return digest ? digest.replace(/^sha256:/i, '').toLowerCase() : null;
}

/** Best-effort list label: the Quay repository path, else the app name. */
export function recordLabel(app: AppConfig): string {
  return asApi<QuayAppApi>(app, 'quay')?.repository ?? app.name;
}

/** Join one app's latest Jenkins build + Quay tag into a record. */
export async function collectApp(
  app: AppConfig,
  clients: DeployClients,
  opts: CollectOptions = {},
): Promise<CollectedRecord> {
  const record: CollectedRecord = { app, label: recordLabel(app), errors: [] };

  const jenkinsApi = asApi<JenkinsAppApi>(app, 'jenkins');
  if (jenkinsApi && clients.jenkins) {
    try {
      const build = await clients.jenkins.getLatestBuildForApp(jenkinsApi, { env: opts.env });
      if (build) {
        record.jenkins = {
          build,
          number: build.number,
          status: buildStatus(build),
          branch: getBuildBranch(build),
          commit: getBuildCommits(build)[0] ?? null,
        };
      }
    } catch (err) {
      record.errors.push(`jenkins: ${(err as Error).message}`);
    }
  }

  const quayApi = asApi<QuayAppApi>(app, 'quay');
  if (quayApi && clients.quay) {
    try {
      const tag = await clients.quay.getLatestTag(quayApi.repository);
      if (tag) {
        record.quay = { tag, version: tag.name, sha256: bareDigest(tag.manifest_digest) };
      }
    } catch (err) {
      record.errors.push(`quay: ${(err as Error).message}`);
    }
  }

  return record;
}

/** Join many apps concurrently. */
export function collectApps(
  apps: AppConfig[],
  clients: DeployClients,
  opts: CollectOptions = {},
): Promise<CollectedRecord[]> {
  return Promise.all(apps.map((app) => collectApp(app, clients, opts)));
}
