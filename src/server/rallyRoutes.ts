/**
 * Rally API routes (pipelines use-case 5). Thin wrappers over the Rally client:
 *   GET  /api/rally/story/:formattedId      → the story, or 404
 *   GET  /api/rally/task/:formattedId       → the task, or 404
 *   POST /api/rally/task/:formattedId/update { state?, notes? } → update it
 *
 * Credential-gated: `rallyFromConfig` throws when RALLY_URL/RALLY_API_KEY are
 * absent, surfaced as a 412 (needsCreds) — never a 500 — so the feature is fully
 * wired and just lights up once creds are in ~/.rubato/.env.
 */

import { type RallyClient, rallyFromConfig } from '../api/rally';
import { json, jsonError } from './http';

export async function handleRallyApi(pathname: string, req: Request): Promise<Response> {
  let rally: RallyClient;
  try {
    rally = await rallyFromConfig();
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'rally not configured', 412, { needsCreds: true });
  }

  const parts = pathname.slice('/api/rally/'.length).split('/').filter(Boolean);
  const [kind, id, action] = parts;

  try {
    if (kind === 'story' && id && !action) {
      if (req.method !== 'GET') return jsonError('use GET', 405);
      const story = await rally.getStory(decodeURIComponent(id));
      return story ? json(story) : jsonError(`story ${id} not found`, 404);
    }

    if (kind === 'task' && id && !action) {
      if (req.method !== 'GET') return jsonError('use GET', 405);
      const task = await rally.getTask(decodeURIComponent(id));
      return task ? json(task) : jsonError(`task ${id} not found`, 404);
    }

    // POST /api/rally/task/:formattedId/update { state?, notes? }
    if (kind === 'task' && id && action === 'update') {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      let body: { state?: unknown; notes?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('invalid JSON body', 400);
      }
      const task = await rally.getTask(decodeURIComponent(id));
      if (!task?.ObjectID) return jsonError(`task ${id} not found`, 404);
      const fields = {
        ...(typeof body.state === 'string' && body.state ? { State: body.state } : {}),
        ...(typeof body.notes === 'string' ? { Notes: body.notes } : {}),
      };
      if (Object.keys(fields).length === 0) return jsonError('provide state and/or notes', 400);
      return json(await rally.updateTask(task.ObjectID, fields));
    }
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'rally request failed', 502);
  }

  return jsonError(`not found: ${pathname}`, 404);
}
