/**
 * HTTP routes for pipelines — CRUD over the JSON store + run + run history +
 * the preload-form variables endpoint. Mirrors automationRoutes.ts; runs fire in
 * the background and stream their lifecycle over /ws (pipeline:*).
 */

import { deletePipeline, getPipeline, listPipelines, savePipeline } from '../lib/pipelines';
import type { Pipeline } from '../shared/pipeline';
import { listPipelineRuns } from './db';
import { json, jsonError, readJsonBody } from './http';
import { missingPipelineVariables, pipelineVariables, startPipelineRun } from './pipelines';

export async function handlePipelineApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/pipeline-runs') {
    const pipeline = new URL(req.url).searchParams.get('pipeline') ?? undefined;
    return json(listPipelineRuns(pipeline));
  }

  if (pathname === '/api/pipelines/run') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const b = await readJsonBody<{ id?: string; pipeline?: Pipeline; variables?: Record<string, string> }>(req);
    if (!b) return jsonError('invalid JSON body', 400);
    const pipeline = b.pipeline ?? (b.id ? await getPipeline(b.id) : null);
    if (!pipeline) return jsonError('pipeline not found', 404);
    const missing = await missingPipelineVariables(pipeline, b.variables);
    if (missing.length) return jsonError('missing required variables', 400, { missing });
    void startPipelineRun(pipeline, b.variables);
    return json({ accepted: true, pipeline: pipeline.name }, 202);
  }

  if (pathname === '/api/pipelines') {
    if (req.method === 'GET') return json(await listPipelines());
    if (req.method === 'POST') {
      const b = await readJsonBody<Partial<Pipeline> & { name?: string; stages?: Pipeline['stages'] }>(req);
      if (!b?.name || !Array.isArray(b.stages)) return jsonError('name and stages required', 400);
      return json(await savePipeline({ ...b, name: b.name, stages: b.stages }));
    }
    return jsonError('use GET or POST', 405);
  }

  // /api/pipelines/:id/variables — preload form data (which vars, set-in-env or not).
  if (pathname.endsWith('/variables')) {
    const id = pathname.slice('/api/pipelines/'.length, -'/variables'.length);
    const p = id ? await getPipeline(id) : null;
    if (!p) return jsonError('not found', 404);
    return json({ variables: await pipelineVariables(p) });
  }

  // /api/pipelines/:id
  const id = pathname.slice('/api/pipelines/'.length);
  if (!id) return jsonError('not found', 404);
  if (req.method === 'GET') {
    const p = await getPipeline(id);
    return p ? json(p) : jsonError('not found', 404);
  }
  if (req.method === 'DELETE') return json({ deleted: await deletePipeline(id) });
  return jsonError('use GET or DELETE', 405);
}
