/**
 * Session/JWT API: fetch a session token from the environment's IdP and let the
 * UI show/copy/save it.
 *
 *   GET  /api/auth/config    → AuthConfigState (configured? creds present? + cached token)
 *   POST /api/auth/session   → SessionTokenResult (run the login; optional cred override/force)
 *   POST /api/auth/save-var  → persist a value (e.g. the JWT) into ~/.rubato/.env
 *
 * Loopback, single-user server — the token is returned to the page so it can be
 * copied or saved as a `${VAR}` for automations/pipelines. The env-specifics
 * (URLs, headers, credential env names) live in config/.env, never committed.
 */

import { getAuthConfigState, getSessionToken } from '../api/auth/sessionToken';
import { setEnvVar } from '../api/env';
import type { FetchSessionRequest, SaveAuthVarRequest } from '../shared/auth';
import { json, jsonError, readJsonBody } from './http';

export async function handleAuthApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/auth/config' && req.method === 'GET') {
    return json(await getAuthConfigState());
  }

  if (pathname === '/api/auth/session' && req.method === 'POST') {
    const body = (await readJsonBody<FetchSessionRequest>(req)) ?? {};
    try {
      const result = await getSessionToken({
        force: body.force,
        username: body.username?.trim() || undefined,
        password: body.password || undefined,
      });
      return json(result);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err), 400);
    }
  }

  if (pathname === '/api/auth/save-var' && req.method === 'POST') {
    const body = await readJsonBody<SaveAuthVarRequest>(req);
    if (!body?.name || typeof body.value !== 'string') {
      return jsonError('name and value are required', 400);
    }
    try {
      setEnvVar(body.name, body.value);
      return json({ ok: true, name: body.name });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err), 400);
    }
  }

  return jsonError('not found', 404);
}
