/**
 * Task Draft Forge API — CRUD over drafts + reusable prompts, plus the actions
 * that drive the Ollama enhancement worker.
 *
 *   GET    /api/forge/drafts            → ForgeDraft[]
 *   POST   /api/forge/drafts            → create (queues the first enhancement)
 *   GET    /api/forge/drafts/:id        → { draft, revisions }
 *   PATCH  /api/forge/drafts/:id        → edit the human fields
 *   DELETE /api/forge/drafts/:id        → { deleted }
 *   POST   /api/forge/drafts/:id/enhance → queue another round { promptId?, promptText? }
 *   POST   /api/forge/drafts/:id/publish → publish current revision into taskq
 *   GET/POST/PATCH/DELETE /api/forge/prompts[/:id]  → saved prompt CRUD
 */

import type { EnhanceRequest, ForgePromptInput, ForgeDraftInput, ForgeDraftPatch } from '../shared/forge';
import {
  createDraft,
  createPrompt,
  deleteDraft,
  deletePrompt,
  getDraftDetail,
  kickForgeWorker,
  listDrafts,
  listPrompts,
  publishDraft,
  requestEnhance,
  updateDraft,
  updatePrompt,
  updateRevision,
} from './forge';
import { json, jsonError, readJsonBody } from './http';

async function handleDrafts(rest: string, req: Request): Promise<Response> {
  // rest is the path after '/api/forge/drafts'  (''| '/:id' | '/:id/enhance' | '/:id/publish')
  if (rest === '' || rest === '/') {
    if (req.method === 'GET') return json(listDrafts());
    if (req.method === 'POST') {
      const body = await readJsonBody<ForgeDraftInput>(req);
      if (!body?.title?.trim()) return jsonError('a title is required', 400);
      const draft = createDraft(body);
      kickForgeWorker();
      return json(draft, 201);
    }
    return jsonError('use GET or POST', 405);
  }

  const parts = rest.slice(1).split('/'); // ['<id>', 'enhance'?]
  const id = Number(parts[0]);
  if (!Number.isInteger(id)) return jsonError('invalid draft id', 400);
  const action = parts[1];

  if (!action) {
    if (req.method === 'GET') {
      const detail = getDraftDetail(id);
      return detail ? json(detail) : jsonError('draft not found', 404);
    }
    if (req.method === 'PATCH') {
      const patch = await readJsonBody<ForgeDraftPatch>(req);
      if (!patch) return jsonError('a JSON body is required', 400);
      const updated = updateDraft(id, patch);
      return updated ? json(updated) : jsonError('draft not found', 404);
    }
    if (req.method === 'DELETE') return json({ deleted: deleteDraft(id) });
    return jsonError('use GET, PATCH, or DELETE', 405);
  }

  if (action === 'enhance') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const body = (await readJsonBody<EnhanceRequest>(req)) ?? {};
    const updated = requestEnhance(id, body);
    if (!updated) return jsonError('draft not found', 404);
    kickForgeWorker();
    return json(updated);
  }

  if (action === 'publish') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const updated = publishDraft(id);
    if (!updated) return jsonError('draft not found', 404);
    if (updated.published_task_id == null) return jsonError('no enhanced revision to publish yet', 409);
    return json(updated);
  }

  return jsonError(`not found: ${action}`, 404);
}

async function handlePrompts(rest: string, req: Request): Promise<Response> {
  if (rest === '' || rest === '/') {
    if (req.method === 'GET') return json(listPrompts());
    if (req.method === 'POST') {
      const body = await readJsonBody<ForgePromptInput>(req);
      if (!body?.name?.trim() || !body?.body?.trim()) return jsonError('name and body are required', 400);
      return json(createPrompt(body), 201);
    }
    return jsonError('use GET or POST', 405);
  }
  const id = Number(rest.slice(1));
  if (!Number.isInteger(id)) return jsonError('invalid prompt id', 400);
  if (req.method === 'PATCH') {
    const body = await readJsonBody<ForgePromptInput>(req);
    if (!body) return jsonError('a JSON body is required', 400);
    const updated = updatePrompt(id, body);
    return updated ? json(updated) : jsonError('prompt not found', 404);
  }
  if (req.method === 'DELETE') return json({ deleted: deletePrompt(id) });
  return jsonError('use PATCH or DELETE', 405);
}

export async function handleForgeApi(pathname: string, req: Request): Promise<Response> {
  const draftsBase = '/api/forge/drafts';
  const promptsBase = '/api/forge/prompts';
  if (pathname === draftsBase || pathname.startsWith(`${draftsBase}/`)) {
    return handleDrafts(pathname.slice(draftsBase.length), req);
  }
  if (pathname.startsWith('/api/forge/revisions/')) {
    if (req.method !== 'PATCH') return jsonError('use PATCH', 405);
    const revId = Number(pathname.slice('/api/forge/revisions/'.length));
    if (!Number.isInteger(revId)) return jsonError('invalid revision id', 400);
    const body = await readJsonBody<{ ai_specification?: string }>(req);
    if (typeof body?.ai_specification !== 'string') return jsonError('ai_specification is required', 400);
    const updated = updateRevision(revId, body.ai_specification);
    return updated ? json(updated) : jsonError('revision not found', 404);
  }
  if (pathname === promptsBase || pathname.startsWith(`${promptsBase}/`)) {
    return handlePrompts(pathname.slice(promptsBase.length), req);
  }
  return jsonError(`not found: ${pathname}`, 404);
}
