/**
 * Wire + config types for the "Session" feature: fetch a session JWT from an
 * environment's challenge/response identity provider (a ForgeRock/PingAM-style
 * auth tree) and show/copy/save it in the UI.
 *
 * The reusable machinery (the callback-challenge loop, cookie jar, token cache,
 * JWT decode) lives in cwip (`runCallbackLogin`, `createSessionFetch`,
 * `createCachedTokenProvider`, `decodeJwt`). The ENV-SPECIFICS — the endpoint
 * URLs, headers, which callback holds the username/password, where the token
 * sits in the exchange response — are config here, so nothing is committed and a
 * different environment is a config edit, not a code change.
 *
 * Pure types only (no runtime imports) so the UI can import via `@shared/auth`.
 */

/** The `auth` block of ~/.rubato/config.json (all optional; absent → unconfigured). */
export interface AuthConfig {
  /** The IdP authenticate endpoint POSTed during the callback-challenge login. */
  authUrl?: string;
  /**
   * The endpoint that, once the session cookie is set, returns the JWT — usually
   * base64-encoded inside a JSON envelope (see `sessionPath`).
   */
  tokenUrl?: string;
  /** Static headers sent on the auth + token requests (e.g. an API-version header). */
  headers?: Record<string, string>;
  /** Env var NAME holding the username (default `AUTH_USERNAME`). */
  usernameEnv?: string;
  /** Env var NAME holding the password (default `AUTH_PASSWORD`). */
  passwordEnv?: string;
  /**
   * Dotted path to the base64-encoded JWT in the token-endpoint JSON response
   * (default `data.session`). The decoded value is the JWT.
   */
  sessionPath?: string;
  /** Skip the session-selection round (trees that go straight to credentials). */
  skipSessionSelection?: boolean;
  /** The session-selection choice value to submit (default 1). */
  sessionChoice?: number;
}

/** What the UI needs to render the Session page without ever seeing the secrets. */
export interface AuthConfigState {
  /** Both authUrl + tokenUrl are configured. */
  configured: boolean;
  /** The username/password env vars are present (in process.env or ~/.rubato/.env). */
  hasCredentials: boolean;
  /** The configured endpoints (shown to the user; not secret). */
  authUrl?: string;
  tokenUrl?: string;
  /** The env var names the server reads credentials from. */
  usernameEnv: string;
  passwordEnv: string;
  /** A previously-fetched token still cached in memory (so the page can show it). */
  cached?: SessionTokenResult;
}

/** The result of a successful session fetch — shown/copied/saved in the UI. */
export interface SessionTokenResult {
  /** The JWT (returned to the loopback UI so it can be copied/saved). */
  token: string;
  /** The session cookie(s) gathered during login, as a `name=value; …` header. */
  cookieHeader: string;
  /** Decoded (NOT verified) JWT claims, for display (sub, exp, …). */
  claims?: Record<string, unknown>;
  /** Expiry in ms-epoch, from the `exp` claim (absent if none). */
  expiresAt?: number;
  /** When this token was fetched (ms-epoch). */
  fetchedAt: number;
}

/** POST /api/auth/session body — optional one-off credential override + force-refresh. */
export interface FetchSessionRequest {
  /** Override the configured username for this fetch only (never stored). */
  username?: string;
  /** Override the configured password for this fetch only (never stored). */
  password?: string;
  /** Bypass the cache and run a fresh login. */
  force?: boolean;
}

/** POST /api/auth/save-var body — persist a value (e.g. the JWT) into ~/.rubato/.env. */
export interface SaveAuthVarRequest {
  /** Env var name (`^[A-Za-z_][A-Za-z0-9_]*$`). */
  name: string;
  /** The value to store (e.g. the fetched JWT). */
  value: string;
}
