/**
 * Fooocus control API — status + start/stop for the chat-page panel. Thin
 * wrapper over `fooocusManager.ts`.
 *
 *   GET  /api/art/fooocus/status        → FooocusStatus
 *   POST /api/art/fooocus/api/start      → start Fooocus-API (:8888)
 *   POST /api/art/fooocus/api/stop       → stop it (only if rubato started it)
 *   POST /api/art/fooocus/ui/start       → start the Fooocus Gradio UI (:7865)
 *   POST /api/art/fooocus/ui/stop        → stop it
 *
 * Every action returns the full FooocusStatus so the UI updates in one round-trip.
 */

import type { FooocusServerId } from '../../shared/fooocus';
import { json, jsonError } from '../http';
import { getFooocusStatus, startFooocus, stopFooocus } from './fooocusManager';

const ACTION_RE = /^\/(api|ui)\/(start|stop)$/;

export async function handleFooocusApi(pathname: string, req: Request): Promise<Response> {
  const rest = pathname.slice('/api/art/fooocus'.length); // '/status' | '/api/start' | '/ui/stop' | …

  if (rest === '/status') return json(await getFooocusStatus());

  const m = rest.match(ACTION_RE);
  if (m) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const which = m[1] as FooocusServerId;
    return json(m[2] === 'start' ? await startFooocus(which) : await stopFooocus(which));
  }

  return jsonError(`not found: ${pathname}`, 404);
}
