/**
 * Ollama control API — status + model management for the Orchestration "Ollama"
 * tab. Thin wrapper over `ollama.ts`.
 *
 *   GET    /api/ollama/status           → OllamaStatus
 *   GET    /api/ollama/models           → OllamaModel[]   (installed)
 *   GET    /api/ollama/running          → OllamaRunningModel[]
 *   POST   /api/ollama/pull   { model } → pull (download) a model
 *   POST   /api/ollama/model  { model } → set rubato's active chat model
 *   POST   /api/ollama/stop   { model } → unload a running model
 *   POST   /api/ollama/show   { model } → raw model details
 *   POST   /api/ollama/serve            → start the daemon (`ollama serve`)
 *   DELETE /api/ollama/models/:name     → delete an installed model
 */

import { json, jsonError, readJsonBody } from './http';
import {
  deleteModel,
  getStatus,
  listModels,
  listRunning,
  pullModel,
  setActiveModel,
  showModel,
  startDaemon,
  unloadModel,
} from './ollama';

async function modelFromBody(req: Request): Promise<string | null> {
  const body = await readJsonBody<{ model?: string }>(req);
  return body?.model?.trim() || null;
}

export async function handleOllamaApi(pathname: string, req: Request): Promise<Response> {
  const rest = pathname.slice('/api/ollama'.length); // '/status' | '/models' | '/models/:name' | ...

  if (rest === '/status') return json(await getStatus());
  if (rest === '/models' && req.method === 'GET') return json(await listModels());
  if (rest === '/running') return json(await listRunning());

  if (rest === '/serve') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    return json(await startDaemon());
  }

  if (rest === '/pull' || rest === '/model' || rest === '/stop' || rest === '/show') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const model = await modelFromBody(req);
    if (!model) return jsonError('a model name is required', 400);
    if (rest === '/pull') return json(await pullModel(model));
    if (rest === '/model') return json(await setActiveModel(model));
    if (rest === '/stop') {
      await unloadModel(model);
      return json({ ok: true });
    }
    return json(await showModel(model));
  }

  if (rest.startsWith('/models/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    const name = decodeURIComponent(rest.slice('/models/'.length));
    await deleteModel(name);
    return json({ deleted: true });
  }

  return jsonError(`not found: ${pathname}`, 404);
}
