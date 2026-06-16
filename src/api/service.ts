/**
 * Shared wiring for service clients built from rubato config + secrets, so each
 * service's `fromConfig` doesn't repeat the "base URL from config-or-env, token
 * from env" dance.
 */

import { optionalEnv, requireEnv } from './env';

export interface ServiceBase {
  baseUrl: string;
  token: string;
}

/**
 * Resolve a service's base URL (config value, else the URL env var) and token
 * (env var), with clear errors pointing at rubato-init when something's missing.
 */
export function resolveServiceBase(opts: {
  service: string;
  configBaseUrl?: string;
  urlEnv: string;
  tokenEnv: string;
}): ServiceBase {
  const baseUrl = opts.configBaseUrl ?? optionalEnv(opts.urlEnv);
  if (!baseUrl) {
    throw new Error(
      `${opts.service}: base URL not set. Add it to ~/.rubato/config.json or set ${opts.urlEnv} in ~/.rubato/.env (run rubato-init).`,
    );
  }
  return { baseUrl, token: requireEnv(opts.tokenEnv) };
}
