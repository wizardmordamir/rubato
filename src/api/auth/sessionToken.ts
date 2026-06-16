/**
 * Session/JWT fetching adapter — the ENVIRONMENT-SPECIFIC half of the "get a
 * session token" feature. The reusable machinery is cwip's: `createSessionFetch`
 * (cookie jar), `runCallbackLogin` + `setCallbackInput` (the challenge loop),
 * `decodeJwt`/`isJwtExpired`, and `createCachedTokenProvider`. This module wires
 * those to the shape of the IdP described in `config.auth`:
 *
 *   1. Run the callback-challenge login against `auth.authUrl` (optionally a
 *      session-selection round, then username/password from ~/.rubato/.env).
 *   2. With the session cookie set, GET `auth.tokenUrl` and read the base64 JWT
 *      at `auth.sessionPath` (default `data.session`); decode it.
 *
 * Nothing is committed: URLs/headers/paths live in ~/.rubato/config.json,
 * credentials in ~/.rubato/.env. A different environment is a config edit.
 */

import {
  createCachedTokenProvider,
  createSessionFetch,
  decodeJwt,
  isJwtExpired,
  runCallbackLogin,
  setCallbackInput,
} from 'cwip';
import { loadConfig } from '../../lib/config';
import type { AuthConfig, AuthConfigState, SessionTokenResult } from '../../shared/auth';
import { optionalEnv } from '../env';

const DEFAULT_USERNAME_ENV = 'AUTH_USERNAME';
const DEFAULT_PASSWORD_ENV = 'AUTH_PASSWORD';
const DEFAULT_SESSION_PATH = 'data.session';
/** Refresh the cached JWT this many seconds before it expires. */
const EXPIRY_LEEWAY_SECONDS = 30;

interface Creds {
  username: string;
  password: string;
}

/** Walk a dotted path (`data.session`) into a parsed JSON object. */
function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function credEnvNames(config: AuthConfig): { user: string; pass: string } {
  return { user: config.usernameEnv ?? DEFAULT_USERNAME_ENV, pass: config.passwordEnv ?? DEFAULT_PASSWORD_ENV };
}

export interface SessionLoginDeps {
  config: AuthConfig;
  creds: Creds;
  /** Injectable fetch (tests); defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * Run the full login + token exchange and return the decoded result. Pure of
 * config/env resolution (everything is passed in) so it's directly testable
 * against a fake IdP.
 */
export async function performSessionLogin(deps: SessionLoginDeps): Promise<SessionTokenResult> {
  const { config, creds } = deps;
  if (!config.authUrl || !config.tokenUrl) {
    throw new Error(
      'auth is not configured — set config.auth.authUrl and config.auth.tokenUrl in ~/.rubato/config.json',
    );
  }
  const sessionFetch = createSessionFetch(deps.fetchImpl ? { fetch: deps.fetchImpl } : undefined);
  const headers = config.headers ?? {};

  // The IdP challenge loop: optional session-selection round, then credentials.
  // (Callback indices follow the common ForgeRock/PingAM tree; the cwip loop +
  // cookie carry is generic — only this fill sequence is env-specific.)
  const fills: Array<(doc: Parameters<typeof setCallbackInput>[0]) => void> = [];
  if (!config.skipSessionSelection) {
    const choice = config.sessionChoice ?? 1;
    fills.push((doc) => {
      setCallbackInput(doc, 1, choice);
    });
  }
  fills.push((doc) => {
    setCallbackInput(doc, 0, creds.username);
    setCallbackInput(doc, 1, creds.password);
  });

  await runCallbackLogin({ fetch: sessionFetch, url: config.authUrl, headers, fills });

  // Exchange the now-set session cookie for the JWT.
  const res = await sessionFetch(config.tokenUrl, { method: 'GET', headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`token endpoint ${config.tokenUrl} returned a non-JSON body: ${text.slice(0, 200)}`);
  }
  const sessionPath = config.sessionPath ?? DEFAULT_SESSION_PATH;
  const encoded = getByPath(body, sessionPath);
  if (typeof encoded !== 'string' || !encoded) {
    throw new Error(`no session token found at "${sessionPath}" in the token-endpoint response`);
  }
  const token = Buffer.from(encoded, 'base64').toString('utf8').trim();

  const decoded = decodeJwt(token);
  const exp =
    typeof decoded?.payload === 'object' && decoded.payload && 'exp' in decoded.payload
      ? (decoded.payload as { exp?: unknown }).exp
      : undefined;
  return {
    token,
    cookieHeader: sessionFetch.cookieHeader(),
    claims: (decoded?.payload as Record<string, unknown> | undefined) ?? undefined,
    expiresAt: typeof exp === 'number' ? exp * 1000 : undefined,
    fetchedAt: Date.now(),
  };
}

async function resolveAuthConfig(): Promise<AuthConfig> {
  const cfg = await loadConfig();
  return cfg.auth ?? {};
}

async function resolveCreds(config: AuthConfig): Promise<Creds> {
  const { user, pass } = credEnvNames(config);
  const username = optionalEnv(user);
  const password = optionalEnv(pass);
  if (!username || !password) {
    throw new Error(`missing credentials — set ${user} and ${pass} in ~/.rubato/.env (or enter them in the UI)`);
  }
  return { username, password };
}

// Cache the last full result; the cwip provider memoizes the JWT and decides
// when to refresh (using the JWT's own `exp`), running the login at most once
// per refresh even under concurrent callers.
let lastResult: SessionTokenResult | null = null;
const provider = createCachedTokenProvider({
  fetchToken: async () => {
    const config = await resolveAuthConfig();
    const creds = await resolveCreds(config);
    lastResult = await performSessionLogin({ config, creds });
    return lastResult.token;
  },
  isExpired: (token) => isJwtExpired(token, EXPIRY_LEEWAY_SECONDS),
});

export interface GetSessionTokenOptions {
  force?: boolean;
  /** One-off credential override (never cached, never stored). */
  username?: string;
  password?: string;
}

/** Fetch (or reuse the cached) session token. A credential override bypasses the cache. */
export async function getSessionToken(opts: GetSessionTokenOptions = {}): Promise<SessionTokenResult> {
  if (opts.username || opts.password) {
    const config = await resolveAuthConfig();
    const base = await resolveCreds(config).catch(() => ({ username: '', password: '' }));
    const creds = { username: opts.username || base.username, password: opts.password || base.password };
    if (!creds.username || !creds.password) throw new Error('enter both a username and password');
    return performSessionLogin({ config, creds });
  }
  await provider(opts.force);
  if (!lastResult) throw new Error('session login produced no token');
  return lastResult;
}

/** The non-secret state the Session page needs to render. */
export async function getAuthConfigState(): Promise<AuthConfigState> {
  const config = await resolveAuthConfig();
  const { user, pass } = credEnvNames(config);
  return {
    configured: Boolean(config.authUrl && config.tokenUrl),
    hasCredentials: Boolean(optionalEnv(user) && optionalEnv(pass)),
    authUrl: config.authUrl,
    tokenUrl: config.tokenUrl,
    usernameEnv: user,
    passwordEnv: pass,
    cached: lastResult ?? undefined,
  };
}

/** Test hook: clear the in-memory cached token/result. */
export function clearSessionCache(): void {
  provider.clear();
  lastResult = null;
}
