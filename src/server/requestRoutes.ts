/**
 * Request-builder API: run an HttpRequest and persist saved requests +
 * environments. Running happens server-side (see requestRunner) so any host is
 * reachable. Variables are interpolated just before the request fires.
 *
 *   POST   /api/requests/run        → HttpResult  ({ request, variables? })
 *   GET    /api/requests            → SavedRequest[]
 *   POST   /api/requests            → save (create, or update when id given)
 *   DELETE /api/requests/:id        → { deleted }
 *   GET    /api/environments        → Environment[]
 *   POST   /api/environments        → save (create/update)
 *   DELETE /api/environments/:id    → { deleted }
 */

import type { Environment, HttpRequest } from '../shared/request/model';
import { interpolate } from '../shared/request/transforms';
import { deleteEnvironment, deleteRequest, listEnvironments, listRequests, saveEnvironment, saveRequest } from './db';
import { json, jsonError, readJsonBody } from './http';
import { runHttpRequest } from './requestRunner';

export async function handleRequestApi(pathname: string, req: Request): Promise<Response> {
  // ── run ──
  if (pathname === '/api/requests/run') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const b = await readJsonBody<{ request?: HttpRequest; variables?: Record<string, string> }>(req);
    if (!b?.request?.url?.trim()) return jsonError('request with a url required', 400);
    const resolved = b.variables ? interpolate(b.request, b.variables) : b.request;
    return json(await runHttpRequest(resolved));
  }

  // ── saved requests ──
  if (pathname === '/api/requests') {
    if (req.method === 'GET') return json(listRequests());
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<{ id?: string; name?: string; folder?: string; request?: HttpRequest }>(req);
    if (!b?.name?.trim() || !b.request) return jsonError('name and request required', 400);
    return json(saveRequest({ id: b.id, name: b.name, folder: b.folder, request: b.request }));
  }
  if (pathname.startsWith('/api/requests/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    return json({ deleted: deleteRequest(decodeURIComponent(pathname.slice('/api/requests/'.length))) });
  }

  // ── environments ──
  if (pathname === '/api/environments') {
    if (req.method === 'GET') return json(listEnvironments());
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<{ id?: string; name?: string; variables?: Environment['variables'] }>(req);
    if (!b?.name?.trim()) return jsonError('name required', 400);
    return json(saveEnvironment({ id: b.id, name: b.name, variables: b.variables ?? [] }));
  }
  if (pathname.startsWith('/api/environments/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    return json({ deleted: deleteEnvironment(decodeURIComponent(pathname.slice('/api/environments/'.length))) });
  }

  return jsonError(`not found: ${pathname}`, 404);
}
