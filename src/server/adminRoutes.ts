/**
 * Admin API — the backups + DB-viewer panels behind the Admin page. Every route
 * here is gated by `ui.admin` in config (404 when disabled, so the surface simply
 * doesn't exist unless the user opted in via ~/.rubato/config.json). The server is
 * loopback-only and single-user, so the config gate is the whole access model.
 *
 * Routes (all under /api/admin):
 *   GET    /api/admin/backups                          list snapshots
 *   POST   /api/admin/backups                          create a snapshot
 *   DELETE /api/admin/backups/:file                    delete a snapshot
 *   GET    /api/admin/backups/:file/download           stream the .sqlite file
 *   GET    /api/admin/backups/:file/tables             list a backup's tables
 *   POST   /api/admin/backups/:file/tables/:table/query  query a backup table
 *   POST   /api/admin/backups/:file/restore            restore tables {tables:[]}
 *   GET    /api/admin/db/tables                         live tables + counts
 *   GET    /api/admin/db/stats                          live per-table stats
 *   POST   /api/admin/db/tables/:table/query            query a live table
 */

import { loadConfig } from '../lib/config';
import type { QueryRequest } from '../shared/ui';
import {
  backupFilePath,
  backupTables,
  createBackup,
  deleteBackup,
  listBackups,
  queryBackupTable,
  restoreBackup,
} from './admin/backups';
import { dbStats, listDbTables, queryDbTable } from './admin/dbViewer';
import { listDiagnostics, readDiagnostic } from './diagnostics';
import { resolveOutputFile } from './files';
import { json, jsonError, readJsonBody } from './http';

/** Stream an output-dir file as a download (scoped to the diagnostics subdir). */
async function downloadDiagnostic(req: Request): Promise<Response> {
  const path = new URL(req.url).searchParams.get('path') ?? '';
  if (!path.startsWith('diagnostics/')) return jsonError('not a diagnostic path', 403);
  const resolved = await resolveOutputFile(path);
  if (!resolved.ok) return jsonError(resolved.error, resolved.status);
  return new Response(Bun.file(resolved.realAbs), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${resolved.file.name}"`,
    },
  });
}

/** Whether the Admin API is enabled (config `ui.admin`). */
export async function adminEnabled(): Promise<boolean> {
  return (await loadConfig()).ui?.admin === true;
}

const seg = (s: string) => decodeURIComponent(s);

/** Wrap a body-returning handler so thrown errors become a 400 with the message. */
function guard(run: () => unknown | Promise<unknown>, status = 400): Promise<Response> {
  return Promise.resolve()
    .then(run)
    .then((data) => json(data))
    .catch((err) => jsonError(err instanceof Error ? err.message : 'admin error', status));
}

export async function handleAdminApi(pathname: string, req: Request): Promise<Response> {
  if (!(await adminEnabled())) return jsonError('admin is disabled', 404);

  const rest = pathname.slice('/api/admin/'.length);
  const parts = rest.split('/').filter(Boolean);

  // ── Live DB viewer ──────────────────────────────────────────────────────────
  if (parts[0] === 'db') {
    if (parts[1] === 'tables' && parts.length === 2 && req.method === 'GET') {
      return guard(() => listDbTables());
    }
    if (parts[1] === 'stats' && parts.length === 2 && req.method === 'GET') {
      return guard(() => dbStats());
    }
    // /db/tables/:table/query
    if (parts[1] === 'tables' && parts[3] === 'query' && parts.length === 4 && req.method === 'POST') {
      const body = (await readJsonBody<QueryRequest>(req)) ?? {};
      return guard(() => queryDbTable(seg(parts[2]), body));
    }
    return jsonError(`not found: ${pathname}`, 404);
  }

  // ── Diagnostics (logs + reports under <outputDir>/diagnostics) ────────────────
  if (parts[0] === 'diagnostics') {
    // /diagnostics            → parsed summary list
    if (parts.length === 1 && req.method === 'GET') {
      return guard(() => listDiagnostics());
    }
    // /diagnostics/content?path=  → one report or log (inline view)
    if (parts[1] === 'content' && parts.length === 2 && req.method === 'GET') {
      const path = new URL(req.url).searchParams.get('path') ?? '';
      const read = await readDiagnostic(path);
      return read.ok ? json(read) : jsonError(read.error, read.status);
    }
    // /diagnostics/download?path=  → stream the file as an attachment
    if (parts[1] === 'download' && parts.length === 2 && req.method === 'GET') {
      return downloadDiagnostic(req);
    }
    return jsonError(`not found: ${pathname}`, 404);
  }

  // ── Backups ─────────────────────────────────────────────────────────────────
  if (parts[0] === 'backups') {
    // /backups
    if (parts.length === 1) {
      if (req.method === 'GET') return guard(() => listBackups());
      if (req.method === 'POST') return guard(() => createBackup());
      return jsonError('use GET or POST', 405);
    }
    const file = seg(parts[1]);
    // /backups/:file
    if (parts.length === 2) {
      if (req.method === 'DELETE') return guard(async () => ({ deleted: await deleteBackup(file) }));
      return jsonError('use DELETE', 405);
    }
    // /backups/:file/download
    if (parts.length === 3 && parts[2] === 'download' && req.method === 'GET') {
      const path = await backupFilePath(file).catch(() => null);
      if (!path) return jsonError('no such backup', 404);
      return new Response(Bun.file(path), {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${file}"`,
        },
      });
    }
    // /backups/:file/tables
    if (parts.length === 3 && parts[2] === 'tables' && req.method === 'GET') {
      return guard(() => backupTables(file));
    }
    // /backups/:file/restore
    if (parts.length === 3 && parts[2] === 'restore' && req.method === 'POST') {
      const body = (await readJsonBody<{ tables?: string[] }>(req)) ?? {};
      return guard(() => restoreBackup(file, body.tables ?? []));
    }
    // /backups/:file/tables/:table/query
    if (parts.length === 5 && parts[2] === 'tables' && parts[4] === 'query' && req.method === 'POST') {
      const body = (await readJsonBody<QueryRequest>(req)) ?? {};
      return guard(() => queryBackupTable(file, seg(parts[3]), body));
    }
    return jsonError(`not found: ${pathname}`, 404);
  }

  return jsonError(`not found: ${pathname}`, 404);
}
