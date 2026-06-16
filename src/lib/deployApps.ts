/**
 * "Which registered apps deploy (and so run scans)?" — the candidates an imported
 * security scan can be associated with.
 *
 * A scan's findings belong to a deployed app: deployment is where the scan happens.
 * In the registry that signal is a Jenkins or Harness integration (an `apis` entry
 * or a free-form `jenkins`/`harness` tag), surfaced uniformly by `effectiveAppTags`.
 * These pure helpers turn the registry into the deploy-app picker the UI offers
 * after an import. Kept separate from the general `apps` registry module because
 * "jenkins/harness ⇒ deployed ⇒ scanned" is scan-domain knowledge.
 */

import { DEPLOY_PIPELINES, type DeployApp, type DeployPipeline } from '../shared/vulnerabilities';
import { type AppConfig, effectiveAppTags } from './apps';

/** The deploy pipelines (jenkins/harness) an app uses, from its effective tags. */
export function appDeployPipelines(app: AppConfig): DeployPipeline[] {
  const tags = new Set(effectiveAppTags(app));
  return DEPLOY_PIPELINES.filter((p) => tags.has(p));
}

/**
 * Registered apps that deploy via Jenkins or Harness — the scan-association
 * candidates. Missing apps are dropped; the rest are sorted by name.
 */
export function deployApps(apps: AppConfig[]): DeployApp[] {
  return apps
    .filter((a) => !a.missing)
    .map((a) => ({ name: a.name, group: a.group ?? null, deploysVia: appDeployPipelines(a) }))
    .filter((a) => a.deploysVia.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}
