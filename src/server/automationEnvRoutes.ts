/**
 * Automation environments API: named sets of variables (Postman-style) that can
 * be selected when running an automation to override `${KEY}` interpolation values.
 *
 *   GET    /api/automation-environments        → AutomationEnvironment[]
 *   POST   /api/automation-environments        → save (create/update)
 *   DELETE /api/automation-environments/:id    → { deleted }
 */

import type { EnvVar } from '../shared/automationEnvironment';
import { deleteAutomationEnvironment, listAutomationEnvironments, saveAutomationEnvironment } from './db';
import { json, jsonError, readJsonBody } from './http';

export async function handleAutomationEnvApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/automation-environments') {
    if (req.method === 'GET') return json(listAutomationEnvironments());
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<{ id?: string; name?: string; variables?: EnvVar[] }>(req);
    if (!b?.name?.trim()) return jsonError('name required', 400);
    return json(saveAutomationEnvironment({ id: b.id, name: b.name, variables: b.variables ?? [] }));
  }
  if (pathname.startsWith('/api/automation-environments/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    const id = decodeURIComponent(pathname.slice('/api/automation-environments/'.length));
    return json({ deleted: deleteAutomationEnvironment(id) });
  }
  return jsonError(`not found: ${pathname}`, 404);
}
