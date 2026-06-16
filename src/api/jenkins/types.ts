/**
 * Jenkins domain types (the bits of Jenkins' JSON API we care about) plus the
 * config needed to build a client. Raw responses carry many more fields; the
 * interfaces keep an index signature so nothing is lost.
 */

import type { JenkinsDefaults } from '../../lib/appApis';

export type {
  JenkinsAppApi,
  JenkinsDefaults,
  JenkinsEnvConfig,
  JenkinsGlobalConfig,
  JenkinsVersionStrategy,
} from '../../lib/appApis';

export type BuildResult = 'SUCCESS' | 'FAILURE' | 'UNSTABLE' | 'ABORTED' | 'NOT_BUILT' | null;

export interface JenkinsChange {
  commitId?: string;
  comment?: string;
  msg?: string;
  author?: { fullName?: string };
  [key: string]: unknown;
}

export interface JenkinsChangeSet {
  kind?: string;
  items?: JenkinsChange[];
  [key: string]: unknown;
}

export interface JenkinsBuildParameter {
  name: string;
  value: unknown;
}

export interface JenkinsAction {
  _class?: string;
  parameters?: JenkinsBuildParameter[];
  lastBuiltRevision?: { SHA1?: string; branch?: Array<{ name?: string; SHA1?: string }> };
  [key: string]: unknown;
}

export interface JenkinsArtifact {
  fileName: string;
  relativePath: string;
  displayPath?: string;
}

export interface JenkinsBuild {
  number: number;
  url: string;
  result: BuildResult;
  building: boolean;
  timestamp: number;
  duration?: number;
  displayName?: string;
  fullDisplayName?: string;
  actions?: JenkinsAction[];
  changeSets?: JenkinsChangeSet[];
  artifacts?: JenkinsArtifact[];
  [key: string]: unknown;
}

export interface JenkinsBuildRef {
  number: number;
  url: string;
}

export interface JenkinsJob {
  name?: string;
  fullName?: string;
  url: string;
  builds?: JenkinsBuild[];
  lastBuild?: JenkinsBuildRef | null;
  lastSuccessfulBuild?: JenkinsBuildRef | null;
  lastFailedBuild?: JenkinsBuildRef | null;
  /** Present for folders / multibranch pipelines. */
  jobs?: JenkinsJob[];
  [key: string]: unknown;
}

/** Everything needed to construct a Jenkins client. */
export interface JenkinsClientConfig {
  baseUrl: string;
  /** Jenkins username (basic auth alongside an API token). */
  username: string;
  /** Jenkins API token. */
  token: string;
  /** Global defaults/conventions applied when resolving app job paths. */
  defaults?: JenkinsDefaults;
  timeoutMs?: number;
  /** Injectable fetch (for tests). */
  fetch?: typeof fetch;
}
