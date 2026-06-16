/**
 * ServiceNow API: saved connections, saved requests, and gated execution against
 * a ServiceNow instance. The REST client + credential resolution are shared in
 * cwip/servicenow (promoted from cursedalchemy's ServiceNow feature); this module
 * is just the rubato DB + routing glue.
 *
 *   GET    /api/servicenow-connections          → SnConnectionWithStatus[]
 *   POST   /api/servicenow-connections          → save (create, or update when id given)
 *   DELETE /api/servicenow-connections/:id       → { deleted }
 *   POST   /api/servicenow-connections/:id/run   → SnRunResult (200 + ok:false on failure)
 *   GET    /api/servicenow-requests              → SnSavedRequest[]
 *   POST   /api/servicenow-requests              → save (create/update)
 *   DELETE /api/servicenow-requests/:id          → { deleted }
 *
 * Credentials NEVER live in the DB: a connection's envKey maps to SN_<KEY>_TOKEN
 * (→ Bearer) / SN_<KEY>_PASSWORD (+ SN_<KEY>_USERNAME → Basic) / SN_<KEY>_URL,
 * resolved from process.env first and then ~/.rubato/.env. Without credentials,
 * run → 412. Reads are always allowed; writes (table_write or a non-GET
 * passthrough) need the connection's allowWrites AND SN_ALLOW_WRITES=true.
 */

import {
  clampSnLimit,
  executeServiceNow,
  resolveSnCredentials,
  type SnRequest,
  snWritesAllowed,
} from 'cwip/servicenow';
import { optionalEnv } from '../api/env';
import type {
  SnConnection,
  SnConnectionInput,
  SnConnectionWithStatus,
  SnRunBody,
  SnRunResult,
  SnSavedRequestInput,
} from '../shared/servicenow';
import { SN_OPERATIONS } from '../shared/servicenow';
import {
  deleteSnConnection,
  deleteSnRequest,
  getSnConnection,
  listSnConnections,
  listSnRequests,
  saveSnConnection,
  saveSnRequest,
} from './db';
import { json, jsonError, readJsonBody } from './http';

// Resolve SN_* credentials through rubato's env order (process.env → ~/.rubato/.env).
const envOptions = { getEnv: (name: string) => optionalEnv(name) };

const withStatus = (conn: SnConnection): SnConnectionWithStatus => {
  const creds = resolveSnCredentials(conn, envOptions);
  return {
    ...conn,
    hasCredentials: creds.hasCredentials,
    authKind: creds.authKind,
    expectedEnv: creds.expectedEnv,
  };
};

const normalizeConnection = (b: Partial<SnConnectionInput>): SnConnectionInput | null => {
  if (!b.name?.trim()) return null;
  return {
    name: b.name.trim(),
    instanceUrl: b.instanceUrl?.trim() ?? '',
    username: b.username ?? '',
    envKey: b.envKey ?? '',
    defaultTable: b.defaultTable?.trim() || 'incident',
    allowWrites: Boolean(b.allowWrites),
  };
};

const isWrite = (req: SnRunBody): boolean => {
  if (req.operation === 'table_write') return true;
  if (req.operation === 'passthrough') {
    const m = (req.method ?? 'GET').toUpperCase();
    return m !== 'GET' && m !== 'HEAD';
  }
  return false;
};

async function runRequest(conn: SnConnection, req: Request): Promise<Response> {
  const creds = resolveSnCredentials(conn, envOptions);
  if (!creds.hasCredentials) {
    return json(
      {
        ok: false,
        error: {
          code: 'no_credentials',
          message: `No credentials on the server for this connection — set ${creds.expectedEnv.join(
            ' or ',
          )} (in the environment or ~/.rubato/.env).`,
        },
      } satisfies SnRunResult,
      412,
    );
  }

  const baseUrl = creds.instanceUrlOverride || conn.instanceUrl;
  if (!baseUrl?.trim()) {
    return json(
      {
        ok: false,
        error: {
          code: 'no_instance_url',
          message: 'No instance URL set for this connection (set one here or via SN_<KEY>_URL).',
        },
      } satisfies SnRunResult,
      412,
    );
  }

  const body = (await readJsonBody<SnRunBody>(req)) ?? ({ operation: 'table_read' } as SnRunBody);
  if (!SN_OPERATIONS.includes(body.operation)) return jsonError('invalid operation', 400);
  if (isWrite(body) && !snWritesAllowed(conn.allowWrites, envOptions)) {
    return json({
      ok: false,
      error: {
        code: 'writes_blocked',
        message: 'Writes are blocked — enable allowWrites on this connection AND set SN_ALLOW_WRITES=true.',
      },
    } satisfies SnRunResult);
  }

  try {
    const result = await executeServiceNow({
      baseUrl,
      creds,
      request: body as SnRequest,
      cap: clampSnLimit(body.limit),
    });
    return json(result satisfies SnRunResult);
  } catch (err) {
    // A bad request shape (missing table/path/sysId) or a network failure is a normal
    // outcome — 200 + ok:false so the UI shows it inline.
    return json({
      ok: false,
      error: { code: 'request_failed', message: (err as Error).message },
    } satisfies SnRunResult);
  }
}

export async function handleServiceNowApi(pathname: string, req: Request): Promise<Response> {
  // ── connections ──
  if (pathname === '/api/servicenow-connections') {
    if (req.method === 'GET') return json(listSnConnections().map(withStatus));
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<Partial<SnConnectionInput> & { id?: string }>(req);
    const input = b ? normalizeConnection(b) : null;
    if (!input) return jsonError('name required', 400);
    return json(withStatus(saveSnConnection({ ...input, id: b?.id })));
  }
  if (pathname.startsWith('/api/servicenow-connections/')) {
    const rest = pathname.slice('/api/servicenow-connections/'.length);
    if (rest.endsWith('/run')) {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      const id = decodeURIComponent(rest.slice(0, -'/run'.length));
      const conn = getSnConnection(id);
      if (!conn) return jsonError('connection not found', 404);
      return runRequest(conn, req);
    }
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    return json({ deleted: deleteSnConnection(decodeURIComponent(rest)) });
  }

  // ── saved requests ──
  if (pathname === '/api/servicenow-requests') {
    if (req.method === 'GET') return json(listSnRequests());
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<Partial<SnSavedRequestInput> & { id?: string }>(req);
    if (!b?.name?.trim() || !b.operation || !SN_OPERATIONS.includes(b.operation)) {
      return jsonError('name and a valid operation required', 400);
    }
    return json(
      saveSnRequest({
        id: b.id,
        name: b.name.trim(),
        connectionId: b.connectionId ?? null,
        operation: b.operation,
        spec: b.spec ?? {},
      }),
    );
  }
  if (pathname.startsWith('/api/servicenow-requests/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    return json({ deleted: deleteSnRequest(decodeURIComponent(pathname.slice('/api/servicenow-requests/'.length))) });
  }

  return jsonError(`not found: ${pathname}`, 404);
}
