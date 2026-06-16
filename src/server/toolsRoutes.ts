/**
 * Saved-tools API: persist Tools-tab items (curl/fetch requests + regexes) in the
 * shared SQLite db so a useful request or pattern can be kept and reloaded.
 *
 *   GET    /api/tools/curl-requests      → SavedCurlRequest[]
 *   POST   /api/tools/curl-requests      → save (create, or update when id given)
 *   DELETE /api/tools/curl-requests/:id  → { deleted }
 *   GET    /api/tools/regexes            → SavedRegex[]
 *   POST   /api/tools/regexes            → save (create, or update when id given)
 *   DELETE /api/tools/regexes/:id        → { deleted }
 *   GET    /api/tools/crons              → SavedCron[]
 *   POST   /api/tools/crons              → save (create, or update when id given)
 *   DELETE /api/tools/crons/:id          → { deleted }
 */

import type { SaveCron, SaveCurlRequest, SaveRegex } from '../shared/types';
import {
  deleteSavedCron,
  deleteSavedCurlRequest,
  deleteSavedRegex,
  listSavedCrons,
  listSavedCurlRequests,
  listSavedRegexes,
  saveCron,
  saveCurlRequest,
  saveRegex,
} from './db';
import { json, jsonError, readJsonBody } from './http';

export async function handleToolsApi(pathname: string, req: Request): Promise<Response> {
  // ── curl requests ──
  if (pathname === '/api/tools/curl-requests') {
    if (req.method === 'GET') return json(listSavedCurlRequests());
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<SaveCurlRequest>(req);
    if (!b) return jsonError('invalid JSON body', 400);
    if (!b.name?.trim() || !b.request) return jsonError('name and request required', 400);
    return json(saveCurlRequest(b));
  }
  if (pathname.startsWith('/api/tools/curl-requests/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    const id = decodeURIComponent(pathname.slice('/api/tools/curl-requests/'.length));
    return json({ deleted: deleteSavedCurlRequest(id) });
  }

  // ── regexes ──
  if (pathname === '/api/tools/regexes') {
    if (req.method === 'GET') return json(listSavedRegexes());
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<SaveRegex>(req);
    if (!b) return jsonError('invalid JSON body', 400);
    if (!b.title?.trim() || !b.pattern) return jsonError('title and pattern required', 400);
    return json(saveRegex(b));
  }
  if (pathname.startsWith('/api/tools/regexes/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    const id = decodeURIComponent(pathname.slice('/api/tools/regexes/'.length));
    return json({ deleted: deleteSavedRegex(id) });
  }

  // ── crons ──
  if (pathname === '/api/tools/crons') {
    if (req.method === 'GET') return json(listSavedCrons());
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<SaveCron>(req);
    if (!b) return jsonError('invalid JSON body', 400);
    if (!b.title?.trim() || !b.expression) return jsonError('title and expression required', 400);
    return json(saveCron(b));
  }
  if (pathname.startsWith('/api/tools/crons/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    const id = decodeURIComponent(pathname.slice('/api/tools/crons/'.length));
    return json({ deleted: deleteSavedCron(id) });
  }

  return jsonError(`not found: ${pathname}`, 404);
}
