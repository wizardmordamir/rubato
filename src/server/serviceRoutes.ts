/**
 * Service catalog API: list the catalogued HTTP service clients (Datadog,
 * Dynatrace, GitHub, GitLab, Quay, Rancher, Harness) with their operations and
 * configured status, and run one operation. Backed by `src/lib/serviceCatalog`,
 * so the same registry powers the web "Services" tab and the `svc` CLI.
 *
 *   GET  /api/services     → ServiceInfo[]
 *   POST /api/services/run → { result } from ServiceRunRequest
 */

import { ApiError } from '../api/client';
import { listServices, runServiceOperation } from '../lib/serviceCatalog';
import type { ServiceRunRequest, ServiceRunResponse } from '../shared/types';
import { json, jsonError } from './http';

export async function handleServiceApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/services') {
    return json(await listServices());
  }

  if (pathname === '/api/services/run') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    let body: ServiceRunRequest;
    try {
      body = (await req.json()) as ServiceRunRequest;
    } catch {
      return jsonError('invalid JSON body', 400);
    }
    if (!body.service || !body.operation) return jsonError('service and operation required', 400);
    try {
      const result = await runServiceOperation(body.service, body.operation, body.params ?? {});
      const res: ServiceRunResponse = { result };
      return json(res);
    } catch (err) {
      // ApiError (auth/network) → 502; bad params / missing keys → 400.
      const status = err instanceof ApiError ? 502 : 400;
      return jsonError(err instanceof Error ? err.message : 'service run failed', status);
    }
  }

  return jsonError(`not found: ${pathname}`, 404);
}
