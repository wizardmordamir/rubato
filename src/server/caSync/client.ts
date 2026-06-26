import { type ApiClient, createApiClient } from '../../api/client';
import type { CaDataKind, PulledTask, TaskUpdatePayload } from '../../shared/caSync';
import type { CaSyncSettings } from './config';

/**
 * Client for ca's key-authed integration API. Every endpoint is a GET (the ca
 * deployment can block non-GET methods); push payloads ride in a base64url `data`
 * query param. The API key is sent as the `x-api-key` header.
 */
export interface CaClient {
  ping(): Promise<void>;
  pull(): Promise<PulledTask[]>;
  update(taskId: string, payload: TaskUpdatePayload): Promise<void>;
  pushData(kind: CaDataKind, payload: unknown): Promise<void>;
}

export function makeCaClient(settings: CaSyncSettings, api?: ApiClient): CaClient {
  const client =
    api ??
    createApiClient({
      name: 'ca-sync',
      baseUrl: `${settings.url}/api/integration`,
      auth: { type: 'header', name: 'x-api-key', value: settings.apiKey ?? '' },
      timeoutMs: 15_000,
    });
  const host = settings.hostId;
  return {
    async ping() {
      await client.get('/ping', { query: { host } });
    },
    async pull() {
      const { data } = await client.get<{ tasks: PulledTask[] }>('/tasks/pull', { query: { host } });
      return data.tasks ?? [];
    },
    async update(taskId, payload) {
      // Server-to-server (key-authed, not a browser session): normal POST body, not the
      // GET-tunnel — payloads (queue snapshots, ASK answers) exceed the GET URL limit.
      await client.post(`/tasks/${encodeURIComponent(taskId)}/update`, { host, ...payload }, { query: { host } });
    },
    async pushData(kind, payload) {
      await client.post('/data', payload, { query: { host, kind } });
    },
  };
}
