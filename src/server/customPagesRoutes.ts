/**
 * Custom Pages API — user-built dashboards (a saved cwip/layout LayoutView).
 *
 *   GET    /api/pages       → CustomPage[]
 *   POST   /api/pages       → save (create, or update when id given)
 *   DELETE /api/pages/:id   → { deleted }
 *
 * The layout is normalized through cwip's `migrateLayoutView` on every read AND
 * write, so a stored layout is always a clean v2 node tree (junk dropped, depth
 * clamped) regardless of what the client sent.
 */

import { migrateLayoutView } from 'cwip/layout';
import type { CustomPage, CustomPageInput } from '../shared/customPage';
import { deleteCustomPage, listCustomPages, saveCustomPage } from './db';
import { json, jsonError, readJsonBody } from './http';

const normalize = (b: Partial<CustomPageInput>): CustomPageInput | null => {
  if (!b.title?.trim()) return null;
  return {
    title: b.title.trim(),
    icon: typeof b.icon === 'string' && b.icon.trim() ? b.icon.trim() : undefined,
    description: typeof b.description === 'string' ? b.description : undefined,
    layout: migrateLayoutView(b.layout),
  };
};

const withMigratedLayout = (p: CustomPage): CustomPage => ({ ...p, layout: migrateLayoutView(p.layout) });

export async function handleCustomPagesApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/pages') {
    if (req.method === 'GET') return json(listCustomPages().map(withMigratedLayout));
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<Partial<CustomPageInput> & { id?: string }>(req);
    const input = b ? normalize(b) : null;
    if (!input) return jsonError('a title is required', 400);
    return json(saveCustomPage({ ...input, id: b?.id }) satisfies CustomPage);
  }
  if (pathname.startsWith('/api/pages/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    return json({ deleted: deleteCustomPage(decodeURIComponent(pathname.slice('/api/pages/'.length))) });
  }
  return jsonError(`not found: ${pathname}`, 404);
}
