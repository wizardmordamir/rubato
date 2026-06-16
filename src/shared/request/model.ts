/**
 * The canonical HTTP request model — the keystone of the request builder. Pure
 * types + tiny helpers, shared between the web UI (via @shared) and the server,
 * and the basis of the portable share file. Designed to be lifted into a
 * standalone "request kit" package later (no React, no server, no Node deps).
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** An enableable key/value row (query params, headers, form fields, env vars). */
export interface KV {
  key: string;
  value: string;
  enabled: boolean;
}

export type AuthConfig =
  | { type: 'none' }
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string }
  | { type: 'apiKey'; key: string; value: string; in: 'header' | 'query' };

/** A multipart field: a text value or an attached file (content base64-encoded). */
export type MultipartField =
  | { kind: 'text'; key: string; value: string; enabled: boolean }
  | { kind: 'file'; key: string; filename: string; contentBase64: string; contentType?: string; enabled: boolean };

export type BodyConfig =
  | { type: 'none' }
  | { type: 'json'; text: string }
  | { type: 'raw'; text: string; contentType: string }
  | { type: 'form'; fields: KV[] } // application/x-www-form-urlencoded
  | { type: 'multipart'; fields: MultipartField[] }; // multipart/form-data

export type BodyType = BodyConfig['type'];

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  query: KV[];
  headers: KV[];
  auth: AuthConfig;
  body: BodyConfig;
}

/** A blank request to start from. */
export function emptyRequest(): HttpRequest {
  return { method: 'GET', url: '', query: [], headers: [], auth: { type: 'none' }, body: { type: 'none' } };
}

/** Result of executing a request (run server-side so any host is reachable). */
export interface HttpResult {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Array<[string, string]>;
  /** Response body as text; the UI pretty-prints JSON. */
  body: string;
  contentType: string;
  sizeBytes: number;
  durationMs: number;
  /** Set (with status 0) when the request never completed (network/timeout). */
  error?: string;
}

/** A saved request (persisted in SQLite). */
export interface SavedRequest {
  id: string;
  name: string;
  /** Optional collection/folder grouping. */
  folder?: string;
  request: HttpRequest;
  createdAt: number;
  updatedAt: number;
}

/** A Postman-style environment: named variables substituted as {{key}}. */
export interface Environment {
  id: string;
  name: string;
  variables: KV[];
  createdAt: number;
  updatedAt: number;
}

/** The portable, importable/exportable share file for a single request. */
export interface RequestFile {
  kind: 'rubato.request';
  version: 1;
  name?: string;
  request: HttpRequest;
}

/** Resolve an environment's enabled variables into a {{key}}→value map. */
export function resolveVars(variables: KV[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of variables) if (v.enabled && v.key.trim()) out[v.key] = v.value;
  return out;
}

/** Enabled rows of a KV list (shared by every consumer). */
export function enabledRows(rows: KV[]): KV[] {
  return rows.filter((r) => r.enabled && r.key.trim() !== '');
}
