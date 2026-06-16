/**
 * Config-driven Jenkins job-path resolution.
 *
 * The same app maps to different Jenkins jobs on different setups (folder
 * layout, multibranch or not, per-environment jobs). Rather than hardcode any of
 * that, the job path is resolved from configuration with a clear precedence:
 *
 *   per-env override  >  per-app setting  >  global default
 *
 * A multibranch pipeline appends the branch as a final folder segment; a plain
 * job does not. An explicit `jobPath` on an env short-circuits everything.
 */

import type { JenkinsAppApi, JenkinsDefaults, JenkinsEnvConfig } from './types';

export interface ResolveJobOptions {
  /** Target environment name (matched against the app's env configs). */
  env?: string;
  /** Branch to build (required for multibranch unless an env default exists). */
  branch?: string;
  /** Global Jenkins defaults (usually the client's). */
  defaults?: JenkinsDefaults;
}

/** Find the app's config block for an environment, case-insensitively. */
export function findEnvConfig(app: JenkinsAppApi, env?: string): JenkinsEnvConfig | undefined {
  if (!env) return undefined;
  const lower = env.toLowerCase();
  return app.envs?.find((e) => e.envName.toLowerCase() === lower);
}

function splitPath(path: string): string[] {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the folder segments for an app's Jenkins job, e.g. ["Deploys", "svc"]
 * or ["Deploys", "svc", "main"] for a multibranch pipeline. Throws a clear error
 * when required config is missing.
 */
export function resolveJobSegments(app: JenkinsAppApi, opts: ResolveJobOptions = {}): string[] {
  const envCfg = findEnvConfig(app, opts.env);

  // An explicit per-env job path wins outright.
  if (envCfg?.jobPath) return splitPath(envCfg.jobPath);

  const project = envCfg?.projectName ?? app.project;
  if (!project) {
    throw new Error(
      `Jenkins: no project configured${opts.env ? ` for env "${opts.env}"` : ''}. ` +
        `Set "project" (or the env's "projectName"/"jobPath") in the app's jenkins config.`,
    );
  }

  const multibranch = envCfg?.multibranch ?? app.multibranch ?? opts.defaults?.multibranch ?? false;
  const segments = splitPath(project);

  if (multibranch) {
    const branch = opts.branch ?? envCfg?.branch;
    if (!branch) {
      throw new Error(
        `Jenkins: "${project}" is multibranch but no branch was given and the env has no default branch. ` +
          `Pass a branch or set "branch" on the env config.`,
      );
    }
    segments.push(branch);
  }
  return segments;
}

/** Turn folder segments into a Jenkins URL path: ["A", "main"] → "job/A/job/main". */
export function toJobUrlPath(segments: string[]): string {
  return segments.map((s) => `job/${encodeURIComponent(s)}`).join('/');
}

/** Resolve straight to a Jenkins URL path for an app + env + branch. */
export function resolveJobUrlPath(app: JenkinsAppApi, opts?: ResolveJobOptions): string {
  return toJobUrlPath(resolveJobSegments(app, opts));
}

/**
 * Best-effort extraction of the configured branch from a job's config.xml. Git
 * jobs store a BranchSpec name like "(star)/main"; the leading wildcard segment
 * is stripped. Returns null when no branch spec is found.
 */
export function parseBranchFromConfigXml(xml: string): string | null {
  const branchSpec = xml.match(/<hudson\.plugins\.git\.BranchSpec>\s*<name>([^<]+)<\/name>/);
  if (branchSpec) return branchSpec[1].replace(/^\*\//, '').trim();

  const generic = xml.match(/<branches>[\s\S]*?<name>([^<]+)<\/name>/);
  if (generic) return generic[1].replace(/^\*\//, '').trim();

  return null;
}
