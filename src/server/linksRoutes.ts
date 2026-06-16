/**
 * Links API: a per-machine, searchable catalogue of URLs (the single-user
 * sibling of cursedalchemy's `/links`).
 *
 *   GET    /api/links          → LinkItem[]
 *   POST   /api/links          → create (no id) or update (with id) a link
 *   POST   /api/links/import   → parse a browser bookmarks.html export and bulk-add
 *   DELETE /api/links/:id      → { deleted }
 *
 * `url` is UNIQUE, so creating a duplicate returns 409 and re-importing dedupes.
 */

import { parseBookmarksHtml } from 'cwip';
import type { LinkItemInput } from '../shared/links';
import { createLink, deleteLink, importLinks, type LinkImportItem, listLinks, updateLink } from './db';
import { json, jsonError, readJsonBody } from './http';

// A SQLite UNIQUE-constraint failure on the url index → the link is already saved.
const isDuplicateUrl = (e: unknown): boolean => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

async function saveLink(req: Request): Promise<Response> {
  const body = await readJsonBody<LinkItemInput & { id?: string }>(req);
  if (!body) return jsonError('a JSON body is required', 400);

  if (body.id) {
    const updated = updateLink(body.id, body);
    if (!updated) return jsonError('link not found', 404);
    return json(updated);
  }

  if (!body.url?.trim()) return jsonError('a url is required', 400);
  try {
    return json(createLink(body), 201);
  } catch (e) {
    if (isDuplicateUrl(e)) return jsonError('that url is already saved', 409);
    throw e;
  }
}

async function importBookmarks(req: Request): Promise<Response> {
  const body = await readJsonBody<{ html?: string }>(req);
  const html = body?.html?.trim();
  if (!html) return jsonError('bookmark HTML is required', 400);
  const items: LinkImportItem[] = parseBookmarksHtml(html).map((b) => ({
    url: b.url,
    title: b.title,
    folder: b.folders.join(' / '),
    favicon: b.icon ?? '',
  }));
  return json(importLinks(items));
}

export async function handleLinksApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/links') {
    if (req.method === 'GET') return json(listLinks());
    if (req.method === 'POST') return saveLink(req);
    return jsonError('use GET or POST', 405);
  }
  if (pathname === '/api/links/import') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    return importBookmarks(req);
  }
  if (pathname.startsWith('/api/links/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    return json({ deleted: deleteLink(decodeURIComponent(pathname.slice('/api/links/'.length))) });
  }
  return jsonError(`not found: ${pathname}`, 404);
}
