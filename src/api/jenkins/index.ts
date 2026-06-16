/**
 * Jenkins API tools — a config-driven client built on the reusable HTTP client.
 *
 * Quick start:
 *   const jenkins = await jenkinsFromConfig();          // base URL + auth from config/.env
 *   const app = getAppApi(myApp, "jenkins");            // per-app config from apps.json
 *   const build = await jenkins.getLatestBuildForApp(app, { env: "stage", filter: { status: "success" } });
 */

export type { BuildSelector, GetBuildsOptions, JenkinsClient, TriggerResult } from './client';
export { createJenkinsClient } from './client';
export type { BuildFilter, StatusFilter } from './filters';
export {
  filterBuildsBy,
  filterByBranch,
  filterByCommit,
  filterByStatus,
  getBuildBranch,
  getBuildCommits,
  getBuildParam,
} from './filters';
export { type AppJenkins, resolveAppJenkins } from './forApp';
export { buildStatus, fmtDuration } from './format';
export { jenkinsFromConfig } from './fromConfig';
export {
  findEnvConfig,
  parseBranchFromConfigXml,
  type ResolveJobOptions,
  resolveJobSegments,
  resolveJobUrlPath,
  toJobUrlPath,
} from './jobs';
export type {
  BuildResult,
  JenkinsAppApi,
  JenkinsArtifact,
  JenkinsBuild,
  JenkinsClientConfig,
  JenkinsDefaults,
  JenkinsEnvConfig,
  JenkinsGlobalConfig,
  JenkinsJob,
} from './types';
