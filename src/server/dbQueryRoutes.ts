/**
 * Query-builder API: saved connections, saved queries, and gated execution.
 * Ported from cursedalchemy's query builder; the shared machinery lives in
 * cwip — `cwip/query` builds/validates (read-only guard), `cwip/dbquery`
 * resolves credentials and executes with lazy drivers (pg/mysql2/mssql/mongodb
 * are optional installs; a missing driver fails only that run).
 *
 *   GET    /api/db-connections          → DbConnectionWithStatus[]
 *   POST   /api/db-connections          → save (create, or update when id given)
 *   DELETE /api/db-connections/:id      → { deleted }
 *   POST   /api/db-connections/:id/run  → RunQueryResult (200 + ok:false on query failure)
 *   GET    /api/db-queries              → SavedDbQuery[]
 *   POST   /api/db-queries              → save (create/update)
 *   DELETE /api/db-queries/:id          → { deleted }
 *
 * Credentials NEVER live in the DB: a connection's envKey maps to
 * QB_<KEY>_URL / QB_<KEY>_PASSWORD / QB_<KEY>_USERNAME, resolved from
 * process.env first and then ~/.rubato/.env (rubato's standard env order).
 * Without credentials, run → 412. Read-only by default; writes need the
 * connection's allowWrites AND QB_ALLOW_WRITES=true in the environment.
 */

import {
  type ConnectionRecord,
  clampCap,
  resolveCredentials,
  runMongo,
  runSqlByDialect,
  writesAllowed,
} from 'cwip/dbquery';
import { assertReadOnlySql, isSqlDialect, WriteQueryBlockedError } from 'cwip/query';
import { optionalEnv } from '../api/env';
import type {
  DbConnection,
  DbConnectionInput,
  DbConnectionWithStatus,
  MongoRunBody,
  RunQueryResult,
  SavedDbQueryInput,
  SqlRunBody,
} from '../shared/queryBuilder';
import { QUERY_DIALECTS } from '../shared/queryBuilder';
import {
  deleteDbConnection,
  deleteSavedDbQuery,
  getDbConnection,
  listDbConnections,
  listSavedDbQueries,
  saveDbConnection,
  saveSavedDbQuery,
} from './db';
import { captureDbRun } from './debugCapture';
import { json, jsonError, readJsonBody } from './http';

// Resolve QB_* credentials through rubato's env order (process.env → ~/.rubato/.env).
const envOptions = { getEnv: (name: string) => optionalEnv(name) };

const withStatus = (conn: DbConnection): DbConnectionWithStatus => {
  const creds = resolveCredentials(conn, envOptions);
  return { ...conn, hasCredentials: creds.hasCredentials, expectedEnv: creds.expectedEnv };
};

const normalizeConnection = (b: Partial<DbConnectionInput>): DbConnectionInput | null => {
  if (!b.name?.trim() || !b.dialect || !QUERY_DIALECTS.includes(b.dialect)) return null;
  return {
    name: b.name.trim(),
    dialect: b.dialect,
    host: b.host ?? '',
    port: typeof b.port === 'number' && Number.isFinite(b.port) ? b.port : null,
    database: b.database ?? '',
    username: b.username ?? '',
    ssl: Boolean(b.ssl),
    envKey: b.envKey ?? '',
    collections: Array.isArray(b.collections) ? b.collections.filter((c) => typeof c === 'string') : [],
    allowWrites: Boolean(b.allowWrites),
  };
};

async function runQuery(conn: DbConnection, req: Request): Promise<Response> {
  const creds = resolveCredentials(conn, envOptions);
  if (!creds.hasCredentials) {
    return json(
      {
        ok: false,
        error: {
          code: 'no_credentials',
          message: `No credentials on the server for this connection — set ${creds.expectedEnv.join(' or ')} (in the environment or ~/.rubato/.env).`,
        },
      } satisfies RunQueryResult,
      412,
    );
  }

  const record: ConnectionRecord = conn;
  try {
    if (conn.dialect === 'mongodb') {
      const b = (await readJsonBody<MongoRunBody>(req)) ?? ({} as MongoRunBody);
      if (!b.collection?.trim()) return jsonError('collection required', 400);
      const find = { collection: b.collection, filter: b.filter, projection: b.projection, sort: b.sort, skip: b.skip };
      const result = await captureDbRun(`mongo:${conn.name}`, `${b.collection}.find`, find, () =>
        runMongo(record, creds, find, clampCap(b.limit)),
      );
      return json({ ok: true, ...result } satisfies RunQueryResult);
    }

    const b = (await readJsonBody<SqlRunBody>(req)) ?? ({} as SqlRunBody);
    const sql = b.query?.trim();
    if (!sql) return jsonError('query required', 400);
    if (!isSqlDialect(conn.dialect)) return jsonError(`unsupported dialect: ${conn.dialect}`, 400);
    if (!writesAllowed(conn, envOptions)) assertReadOnlySql(sql);
    const result = await captureDbRun(`${conn.dialect}:${conn.name}`, sql, { limit: clampCap(b.limit) }, () =>
      runSqlByDialect(record, creds, sql, clampCap(b.limit)),
    );
    return json({ ok: true, ...result } satisfies RunQueryResult);
  } catch (err) {
    // Query/driver/connection failures are a normal outcome — 200 + ok:false so
    // the UI shows them inline; the WriteQueryBlockedError gets its own code.
    const code = err instanceof WriteQueryBlockedError ? 'writes_blocked' : 'query_failed';
    return json({ ok: false, error: { code, message: (err as Error).message } } satisfies RunQueryResult);
  }
}

export async function handleDbQueryApi(pathname: string, req: Request): Promise<Response> {
  // ── connections ──
  if (pathname === '/api/db-connections') {
    if (req.method === 'GET') return json(listDbConnections().map(withStatus));
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<Partial<DbConnectionInput> & { id?: string }>(req);
    const input = b ? normalizeConnection(b) : null;
    if (!input) return jsonError('name and a valid dialect required', 400);
    return json(withStatus(saveDbConnection({ ...input, id: b?.id })));
  }
  if (pathname.startsWith('/api/db-connections/')) {
    const rest = pathname.slice('/api/db-connections/'.length);
    if (rest.endsWith('/run')) {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      const id = decodeURIComponent(rest.slice(0, -'/run'.length));
      const conn = getDbConnection(id);
      if (!conn) return jsonError('connection not found', 404);
      return runQuery(conn, req);
    }
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    return json({ deleted: deleteDbConnection(decodeURIComponent(rest)) });
  }

  // ── saved queries ──
  if (pathname === '/api/db-queries') {
    if (req.method === 'GET') return json(listSavedDbQueries());
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<Partial<SavedDbQueryInput> & { id?: string }>(req);
    if (!b?.name?.trim() || !b.kind || typeof b.queryText !== 'string') {
      return jsonError('name, kind, and queryText required', 400);
    }
    return json(
      saveSavedDbQuery({
        id: b.id,
        name: b.name.trim(),
        connectionId: b.connectionId ?? null,
        dialect: b.dialect && QUERY_DIALECTS.includes(b.dialect) ? b.dialect : 'postgres',
        kind: b.kind === 'mongo' ? 'mongo' : 'sql',
        collection: b.collection,
        spec: b.spec,
        queryText: b.queryText,
      }),
    );
  }
  if (pathname.startsWith('/api/db-queries/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    return json({ deleted: deleteSavedDbQuery(decodeURIComponent(pathname.slice('/api/db-queries/'.length))) });
  }

  return jsonError(`not found: ${pathname}`, 404);
}
