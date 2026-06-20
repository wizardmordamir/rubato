/**
 * Fooocus control API — status, lifecycle, and the `/art-tuning` page's data layer.
 * Thin wrapper over `fooocusManager.ts` (process control) + `fooocusTuning.ts`
 * (config + live-API proxies). All routes hang off `/api/art/fooocus/…`.
 *
 *   GET  /api/art/fooocus/status         → FooocusStatus
 *   POST /api/art/fooocus/api/start       → start Fooocus-API (:8888)
 *   POST /api/art/fooocus/api/stop        → stop it (only if rubato started it)
 *   POST /api/art/fooocus/api/restart     → restart it (apply new memory flags)
 *   POST /api/art/fooocus/ui/{start,stop,restart} → same for the Gradio UI (:7865)
 *   GET  /api/art/fooocus/tuning          → ArtTuningState (generation + memory defaults)
 *   POST /api/art/fooocus/tuning          → save a partial tuning patch
 *   GET  /api/art/fooocus/options         → live models / loras / styles
 *   GET  /api/art/fooocus/stats           → host memory gauge + job-queue state
 *   POST /api/art/fooocus/clean-vram      → unload models + free memory now
 *
 * Lifecycle actions return the full FooocusStatus so the UI updates in one round-trip.
 */

import type { FooocusServerId } from '../../shared/fooocus';
import { json, jsonError } from '../http';
import { getFooocusStatus, restartFooocus, startFooocus, stopFooocus } from './fooocusManager';
import { cleanFooocusVram, fooocusOptions, fooocusStats, getArtTuning, saveArtTuning } from './fooocusTuning';

const ACTION_RE = /^\/(api|ui)\/(start|stop|restart)$/;

export async function handleFooocusApi(pathname: string, req: Request): Promise<Response> {
  const rest = pathname.slice('/api/art/fooocus'.length); // '/status' | '/api/start' | '/tuning' | …

  if (rest === '/status') return json(await getFooocusStatus());

  // Tuning: the generation + memory defaults the /art-tuning page reads & saves.
  if (rest === '/tuning') {
    if (req.method === 'GET') return json(await getArtTuning());
    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonError('invalid JSON body', 400);
      }
      const patch = (body && typeof body === 'object' ? body : {}) as Parameters<typeof saveArtTuning>[0];
      return json(await saveArtTuning(patch));
    }
    return jsonError('use GET or POST', 405);
  }

  if (rest === '/options') return json(await fooocusOptions());
  if (rest === '/stats') return json(await fooocusStats());

  if (rest === '/clean-vram') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    return json(await cleanFooocusVram());
  }

  const m = rest.match(ACTION_RE);
  if (m) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const which = m[1] as FooocusServerId;
    const action = m[2];
    if (action === 'start') return json(await startFooocus(which));
    if (action === 'stop') return json(await stopFooocus(which));
    return json(await restartFooocus(which));
  }

  return jsonError(`not found: ${pathname}`, 404);
}
