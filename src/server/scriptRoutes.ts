/**
 * HTTP routes for custom scripts:
 *   GET  /api/scripts        — the merged catalog (registered + discovered files).
 *   POST /api/scripts/run    — fire a script; progress streams over /ws (script:*).
 * Mirrors the automation routes' fire-and-forget shape.
 */

import type { ScriptParamValues } from '../shared/pipeline';
import { json, jsonError, readJsonBody } from './http';
import { listScripts, startScriptRun } from './scripts';

export async function handleScriptApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/scripts') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return json(await listScripts());
  }

  if (pathname === '/api/scripts/run') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const b = await readJsonBody<{ id?: string; params?: ScriptParamValues; variables?: Record<string, string> }>(req);
    if (!b?.id) return jsonError('id required', 400);
    const known = (await listScripts()).some((s) => s.id === b.id);
    if (!known) return jsonError(`unknown script: ${b.id}`, 404);
    // Fire and forget — output + verdict arrive over /ws.
    void startScriptRun(b.id, { vars: b.variables, params: b.params });
    return json({ accepted: true, script: b.id }, 202);
  }

  return jsonError(`not found: ${pathname}`, 404);
}
