/**
 * Board API: a simple Jira-like kanban of work tasks plus image attachments.
 *
 *   GET    /api/board              → BoardTask[]
 *   POST   /api/board              → save (create, or update when id given)
 *   DELETE /api/board/:id          → { deleted }
 *   POST   /api/board/upload       → { url } (multipart form, field "file")
 *   GET    /api/board/images/:name → the stored image bytes
 *
 * Images land under ~/.rubato/uploads/board/ with a generated name (original
 * extension kept when it's a known image type). The serve route only accepts
 * that generated-name shape, so there is no path-traversal surface.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { RUBATO_HOME } from '../lib/config';
import { BOARD_STATUSES, type BoardTask, type BoardTaskInput } from '../shared/board';
import { deleteBoardTask, listBoardTasks, saveBoardTask } from './db';
import { json, jsonError, readJsonBody } from './http';

const IMAGES_DIR = resolve(RUBATO_HOME, 'uploads', 'board');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

// Only names this server generated: uuid + a known image extension.
const SAFE_IMAGE_NAME = /^[0-9a-f-]{36}\.(png|jpe?g|gif|webp|svg)$/;

const normalizeTask = (b: Partial<BoardTaskInput>): BoardTaskInput | null => {
  if (!b.title?.trim() || !b.status || !BOARD_STATUSES.includes(b.status)) return null;
  return {
    title: b.title.trim(),
    description: typeof b.description === 'string' ? b.description : undefined,
    notes: typeof b.notes === 'string' ? b.notes : undefined,
    links: Array.isArray(b.links) ? b.links.filter((l) => typeof l === 'string' && l.trim()) : [],
    images: Array.isArray(b.images) ? b.images.filter((i) => typeof i === 'string') : [],
    status: b.status,
    position: typeof b.position === 'number' && Number.isFinite(b.position) ? b.position : Date.now(),
  };
};

async function uploadImage(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("multipart form data with a 'file' field required", 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return jsonError("'file' field required", 400);
  if (file.size > MAX_IMAGE_BYTES) return jsonError('image too large (10MB max)', 413);
  const ext = extname(file.name).toLowerCase();
  if (!IMAGE_TYPES[ext]) return jsonError(`unsupported image type: ${ext || '(none)'}`, 400);

  mkdirSync(IMAGES_DIR, { recursive: true });
  const name = `${randomUUID()}${ext}`;
  await Bun.write(resolve(IMAGES_DIR, name), file);
  return json({ url: `/api/board/images/${name}` });
}

function serveImage(name: string): Response {
  if (!SAFE_IMAGE_NAME.test(name)) return jsonError('not found', 404);
  const path = resolve(IMAGES_DIR, name);
  const file = Bun.file(path);
  return new Response(file, {
    headers: { 'content-type': IMAGE_TYPES[extname(name)] ?? 'application/octet-stream' },
  });
}

export async function handleBoardApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/board') {
    if (req.method === 'GET') return json(listBoardTasks());
    if (req.method !== 'POST') return jsonError('use GET or POST', 405);
    const b = await readJsonBody<Partial<BoardTaskInput> & { id?: string }>(req);
    const input = b ? normalizeTask(b) : null;
    if (!input) return jsonError('title and a valid status required', 400);
    return json(saveBoardTask({ ...input, id: b?.id }) satisfies BoardTask);
  }
  if (pathname === '/api/board/upload') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    return uploadImage(req);
  }
  if (pathname.startsWith('/api/board/images/')) {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return serveImage(decodeURIComponent(pathname.slice('/api/board/images/'.length)));
  }
  if (pathname.startsWith('/api/board/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    return json({ deleted: deleteBoardTask(decodeURIComponent(pathname.slice('/api/board/'.length))) });
  }
  return jsonError(`not found: ${pathname}`, 404);
}
