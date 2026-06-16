/**
 * Construct a Jenkins client from the user's rubato config + secrets, so callers
 * don't wire up base URL/auth by hand:
 *   - base URL: config.jenkins.baseUrl, else the JENKINS_URL env var
 *   - auth: JENKINS_USER + JENKINS_API_TOKEN from ~/.rubato/.env
 *   - defaults: config.jenkins.defaults
 *
 * Run `rubato-init` to scaffold the config + .env.
 */

import { loadConfig } from '../../lib/config';
import { optionalEnv, requireEnv } from '../env';
import { createJenkinsClient, type JenkinsClient } from './client';

export async function jenkinsFromConfig(): Promise<JenkinsClient> {
  const cfg = await loadConfig();
  const baseUrl = cfg.jenkins?.baseUrl ?? optionalEnv('JENKINS_URL');
  if (!baseUrl) {
    throw new Error(
      'Jenkins base URL not set. Add "jenkins.baseUrl" to ~/.rubato/config.json or set JENKINS_URL in ~/.rubato/.env (run rubato-init).',
    );
  }
  return createJenkinsClient({
    baseUrl,
    username: requireEnv('JENKINS_USER'),
    token: requireEnv('JENKINS_API_TOKEN'),
    defaults: cfg.jenkins?.defaults,
  });
}
