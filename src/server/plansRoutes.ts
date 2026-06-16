/**
 * Plans API: stored AI remediation plans (Markdown docs) — list, view, save
 * (create/update, used for both the AI-generated plan and manual edits), and delete.
 *
 *   GET    /api/plans        → Plan[]
 *   POST   /api/plans        → save (create, or update when id given) → Plan
 *   GET    /api/plans/:id    → Plan
 *   DELETE /api/plans/:id    → { deleted }
 */

import type { Plan, PlanInput } from '../shared/plans';
import { deletePlan, getPlan, listPlans, savePlan } from './db';
import { json, jsonError, readJsonBody } from './http';

function normalize(b: Partial<PlanInput> & { id?: string }): (PlanInput & { id?: string }) | null {
  if (!b.title?.trim() || typeof b.content !== 'string') return null;
  return {
    id: b.id,
    title: b.title.trim(),
    app: b.app?.trim() || null,
    source: b.source?.trim() || null,
    content: b.content,
  };
}

export async function handlePlansApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/plans') {
    if (req.method === 'GET') return json(listPlans() satisfies Plan[]);
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<Partial<PlanInput> & { id?: string }>(req);
    const input = b ? normalize(b) : null;
    if (!input) return jsonError('title and content required', 400);
    return json(savePlan(input) satisfies Plan);
  }
  if (pathname.startsWith('/api/plans/')) {
    const id = decodeURIComponent(pathname.slice('/api/plans/'.length));
    if (req.method === 'GET') {
      const plan = getPlan(id);
      return plan ? json(plan satisfies Plan) : jsonError('plan not found', 404);
    }
    if (req.method !== 'DELETE') return jsonError('use GET or DELETE', 405);
    return json({ deleted: deletePlan(id) });
  }
  return jsonError(`not found: ${pathname}`, 404);
}
