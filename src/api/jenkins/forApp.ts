/**
 * Bridge the app registry to the Jenkins client for command scripts: resolve an
 * app query, pull its jenkins config, and build a client — failing with a clear,
 * actionable message (and exiting) at whichever step is missing. Keeps jenk,
 * deploy, lastdeploy, jenkbranch, etc. to a few lines each.
 */

import { type AppConfig, getAppApi, resolveApp } from '../../lib/apps';
import type { JenkinsClient } from './client';
import { jenkinsFromConfig } from './fromConfig';
import type { JenkinsAppApi } from './types';

export interface AppJenkins {
  app: AppConfig;
  jenkins: JenkinsAppApi;
  client: JenkinsClient;
}

export async function resolveAppJenkins(query: string): Promise<AppJenkins> {
  const app = await resolveApp(query); // throws if unresolved/ambiguous
  const jenkins = getAppApi(app, 'jenkins');
  if (!jenkins) {
    throw new Error(
      `rubato: "${app.name}" has no jenkins config in ~/.rubato/apps.json.\n` +
        'Add an api entry: { "name": "jenkins", "project": "<folder>", ... } (see rubato-init).',
    );
  }
  const client = await jenkinsFromConfig(); // throws with guidance if config/secrets missing
  return { app, jenkins, client };
}
