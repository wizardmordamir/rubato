/**
 * Debug API (folded into runs/captures — the standalone Debug Capture page was
 * retired). The capture mechanism (debugCapture.ts) is now enabled automatically
 * while a run/step session executes, tagging each outbound call with the request's
 * correlation id; this endpoint reads it back.
 *
 *   GET  /api/debug-capture/logs?correlationId= → { logs, captures } for one request
 */

import { logsForCorrelation } from '../lib/logAccumulator';
import { captureRecords } from './debugCapture';
import { json, jsonError } from './http';

export async function handleDebugCaptureApi(pathname: string, _req: Request): Promise<Response> {
  // Everything for one request, keyed by its correlation id: the full server logs
  // it produced + the outbound API/DB calls it made.
  if (pathname === '/api/debug-capture/logs') {
    if (_req.method !== 'GET') return jsonError('use GET', 405);
    const correlationId = new URL(_req.url).searchParams.get('correlationId') ?? '';
    if (!correlationId) return jsonError('correlationId required', 400);
    const captures = captureRecords().filter(
      (r) => (r.meta as { correlationId?: string } | undefined)?.correlationId === correlationId,
    );
    return json({ correlationId, logs: logsForCorrelation(correlationId), captures });
  }
  return jsonError(`not found: ${pathname}`, 404);
}
