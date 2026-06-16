/**
 * Wire types for the Queries page (SQL/Mongo query builder), shared between the
 * server routes (src/server/dbQueryRoutes.ts) and the UI. Query *construction*
 * is cwip/query (browser-safe); *execution* is cwip/dbquery on the server.
 * Connections never carry a password — the server resolves credentials from
 * the environment (process.env, then ~/.rubato/.env) via the connection's
 * envKey: QB_<KEY>_URL / QB_<KEY>_PASSWORD / QB_<KEY>_USERNAME.
 */

export const QUERY_DIALECTS = ['postgres', 'mysql', 'mssql', 'mongodb'] as const;
export type QueryDialect = (typeof QUERY_DIALECTS)[number];

export interface DbConnectionInput {
  name: string;
  dialect: QueryDialect;
  host: string;
  port: number | null;
  database: string;
  username: string;
  ssl: boolean;
  /** Key the server maps to QB_<KEY>_* env vars for credentials. */
  envKey: string;
  /** Known tables/collections, offered as quick picks in the builder. */
  collections: string[];
  /** Per-connection write opt-in (also needs QB_ALLOW_WRITES=true on the server). */
  allowWrites: boolean;
}

export interface DbConnection extends DbConnectionInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** A connection as listed by the API — annotated with credential presence (never the secret). */
export interface DbConnectionWithStatus extends DbConnection {
  hasCredentials: boolean;
  /** The env var names the operator must set to enable execution. */
  expectedEnv: string[];
}

export interface SavedDbQueryInput {
  name: string;
  connectionId: string | null;
  dialect: QueryDialect;
  kind: 'sql' | 'mongo';
  /** The target table/collection (mongo runs need it; SQL keeps it for reload UX). */
  collection?: string;
  /** Free-form builder state, round-tripped so a saved query reloads into the form. */
  spec?: unknown;
  /** The generated/edited SQL (or mongosh preview) — what actually runs for SQL. */
  queryText: string;
}

export interface SavedDbQuery extends SavedDbQueryInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** POST /api/db-connections/:id/run — body for a SQL connection. */
export interface SqlRunBody {
  query: string;
  limit?: number;
}

/** POST /api/db-connections/:id/run — body for a mongodb connection. */
export interface MongoRunBody {
  collection: string;
  filter?: Record<string, unknown>;
  projection?: Record<string, 0 | 1>;
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
}

export interface RunQuerySuccess {
  ok: true;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

export interface RunQueryFailure {
  ok: false;
  error: { code: string; message: string };
}

/** Query failures come back as 200 + ok:false so the UI can render them inline. */
export type RunQueryResult = RunQuerySuccess | RunQueryFailure;
