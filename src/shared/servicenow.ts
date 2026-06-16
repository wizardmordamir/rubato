/**
 * Wire types for the ServiceNow page, shared between the server route
 * (src/server/servicenowRoutes.ts) and the UI. The REST client + credential
 * resolution live in `cwip/servicenow` (server-side); these are just the saved
 * connection / saved request / run shapes. Pure data/types only (no runtime
 * imports) so the UI can import via `@shared`.
 *
 * Connections NEVER carry a secret — the server resolves credentials from the
 * environment (process.env, then ~/.rubato/.env) via the connection's envKey:
 * SN_<KEY>_TOKEN (→ Bearer) / SN_<KEY>_PASSWORD (+ SN_<KEY>_USERNAME → Basic) /
 * SN_<KEY>_URL (optional instance-URL override).
 */

export const SN_OPERATIONS = ['table_read', 'table_write', 'passthrough'] as const;
export type SnOperation = (typeof SN_OPERATIONS)[number];
export type SnWriteMode = 'create' | 'update';
export type SnHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type SnAuthKind = 'bearer' | 'basic' | 'none';

export interface SnConnectionInput {
  name: string;
  /** ServiceNow base, e.g. https://dev12345.service-now.com (SN_<KEY>_URL can override). */
  instanceUrl: string;
  /** Username for Basic auth (the password comes from SN_<KEY>_PASSWORD). */
  username: string;
  /** Key the server maps to SN_<KEY>_* env vars for credentials. */
  envKey: string;
  /** Table pre-filled in the builder (e.g. "incident"). */
  defaultTable: string;
  /** Per-connection write opt-in (also needs SN_ALLOW_WRITES=true on the server). */
  allowWrites: boolean;
}

export interface SnConnection extends SnConnectionInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** A connection as listed by the API — annotated with credential presence (never the secret). */
export interface SnConnectionWithStatus extends SnConnection {
  hasCredentials: boolean;
  authKind: SnAuthKind;
  /** The env var names the operator must set to enable execution. */
  expectedEnv: string[];
}

/** The full request shape stored on a saved request + sent (with `operation`) to /run. */
export interface SnRequestSpec {
  // table_read
  table?: string;
  query?: string;
  fields?: string[];
  limit?: number;
  offset?: number;
  displayValue?: 'true' | 'false' | 'all';
  // table_write
  writeMode?: SnWriteMode;
  sysId?: string;
  body?: unknown;
  // passthrough
  method?: SnHttpMethod;
  path?: string;
  queryParams?: Record<string, string>;
}

export interface SnSavedRequestInput {
  name: string;
  connectionId: string | null;
  operation: SnOperation;
  spec: SnRequestSpec;
}

export interface SnSavedRequest extends SnSavedRequestInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** Body for POST /api/servicenow-connections/:id/run (operation + the spec, flattened). */
export type SnRunBody = { operation: SnOperation } & SnRequestSpec;

export interface SnRunResult {
  ok: boolean;
  status?: number;
  result?: unknown;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  durationMs?: number;
  error?: { code: string; message: string };
}
