/**
 * Build the service clients a deploy command needs, once per run, skipping any
 * that aren't configured on this machine (so a missing Quay/Git setup degrades to
 * blank columns rather than a crash). Shared by appall / shalist / verifyshas /
 * checkimageshas.
 */

import { gitlabFromConfig } from '../../api/gitlab';
import { jenkinsFromConfig } from '../../api/jenkins';
import { quayFromConfig } from '../../api/quay';
import type { KnownApiName } from '../appApis';
import { type AppConfig, getAppApi } from '../apps';
import type { DeployClients } from './collect';

/** Build a client, or null if it isn't configured/constructable on this machine. */
export async function tryClient<T>(make: () => Promise<T>): Promise<T | null> {
  try {
    return await make();
  } catch {
    return null;
  }
}

export interface WantClients {
  jenkins?: boolean;
  quay?: boolean;
  gitlab?: boolean;
}

/**
 * Construct the requested clients, but only those at least one app actually uses.
 * Defaults to jenkins + quay (the appall/shalist pair); pass `{ gitlab: true }`
 * to add Git enrichment for verification.
 */
export async function buildDeployClients(
  apps: AppConfig[],
  want: WantClients = { jenkins: true, quay: true },
): Promise<DeployClients> {
  const needed = (name: KnownApiName) => apps.some((a) => getAppApi(a, name));
  const [jenkins, quay, gitlab] = await Promise.all([
    want.jenkins && needed('jenkins') ? tryClient(jenkinsFromConfig) : Promise.resolve(null),
    want.quay && needed('quay') ? tryClient(quayFromConfig) : Promise.resolve(null),
    want.gitlab && needed('gitlab') ? tryClient(gitlabFromConfig) : Promise.resolve(null),
  ]);
  return { jenkins, quay, gitlab };
}
