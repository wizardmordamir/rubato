import { describe, expect, test } from 'bun:test';
import type { ApiClient } from '../../api/client';
import type { PulledTask } from '../../shared/caSync';
import { makeCaClient } from './client';
import type { CaSyncSettings } from './config';
import { resolveCaSync } from './config';
import { type CaClient, pullOnce } from './sync';

const enabled: CaSyncSettings = {
  enabled: true,
  url: 'https://ca.example',
  apiKey: 'cak_test',
  hostId: 'box-1',
  pullIntervalMs: 60_000,
  pushIntervalMs: 60_000,
};

const task = (over: Partial<PulledTask>): PulledTask => ({
  id: 'ca-1',
  title: 'do it',
  body: 'body',
  repo: 'ca',
  model: 'sonnet',
  think: 'low',
  fast: false,
  groupKey: null,
  slug: null,
  needs: [],
  status: 'ready',
  enhanceMode: 'direct',
  ...over,
});

// A CaClient stub that records the update payloads it receives.
const stubClient = (tasks: PulledTask[]) => {
  const updates: { id: string; payload: any }[] = [];
  const client: CaClient = {
    ping: async () => {},
    pull: async () => tasks,
    update: async (id, payload) => {
      updates.push({ id, payload });
    },
    pushData: async () => {},
  };
  return { client, updates };
};

describe('pullOnce routing', () => {
  test('direct tasks go straight to the queue and report the taskq id', async () => {
    const { client, updates } = stubClient([task({ id: 'd1', enhanceMode: 'direct' })]);
    const enqueued: PulledTask[] = [];
    const res = await pullOnce({
      settings: enabled,
      client,
      enqueueDirect: (t) => {
        enqueued.push(t);
        return 777;
      },
      enqueueOllama: () => {
        throw new Error('should not enhance a direct task');
      },
    });
    expect(res).toEqual({ pulled: 1, queued: 1 });
    expect(enqueued).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: 'd1', payload: { remoteTaskId: 777, status: 'ready' } });
  });

  test('ollama tasks are handed to Forge and reported as enhancing', async () => {
    const { client, updates } = stubClient([task({ id: 'o1', enhanceMode: 'ollama' })]);
    const drafted: PulledTask[] = [];
    const res = await pullOnce({
      settings: enabled,
      client,
      enqueueDirect: () => {
        throw new Error('should not directly queue an ollama task');
      },
      enqueueOllama: (t) => drafted.push(t),
    });
    expect(res.queued).toBe(1);
    expect(drafted).toHaveLength(1);
    expect(updates[0].payload.status).toBe('enhancing');
  });

  test("a `hold` task is queued as on_hold", async () => {
    const { client, updates } = stubClient([task({ id: 'h1', status: 'hold' })]);
    let captured: PulledTask | null = null;
    await pullOnce({
      settings: enabled,
      client,
      enqueueDirect: (t) => {
        captured = t;
        return 1;
      },
    });
    expect(captured!.status).toBe('hold');
    expect(updates[0].payload.status).toBe('on_hold');
  });

  test('a per-task failure is isolated and reported as failed', async () => {
    const { client, updates } = stubClient([
      task({ id: 'bad' }),
      task({ id: 'good' }),
    ]);
    const res = await pullOnce({
      settings: enabled,
      client,
      enqueueDirect: (t) => {
        if (t.id === 'bad') throw new Error('boom');
        return 5;
      },
    });
    expect(res.queued).toBe(1); // only "good" succeeded
    expect(updates.find((u) => u.id === 'bad')?.payload.status).toBe('failed');
    expect(updates.find((u) => u.id === 'good')?.payload.remoteTaskId).toBe(5);
  });

  test('does nothing when sync is disabled', async () => {
    let pulled = false;
    const client: CaClient = {
      ping: async () => {},
      pull: async () => {
        pulled = true;
        return [];
      },
      update: async () => {},
      pushData: async () => {},
    };
    const res = await pullOnce({ settings: { ...enabled, enabled: false }, client });
    expect(res).toEqual({ pulled: 0, queued: 0 });
    expect(pulled).toBe(false);
  });
});

describe('makeCaClient wire format', () => {
  // A fake ApiClient that records every GET (path + query).
  const fakeApi = (pullData: unknown = { tasks: [] }) => {
    const calls: { path: string; query: Record<string, any> }[] = [];
    const api = {
      get: async (path: string, opts?: any) => {
        calls.push({ path, query: opts?.query ?? {} });
        return { data: pullData, status: 200, headers: new Headers(), url: path };
      },
    } as unknown as ApiClient;
    return { api, calls };
  };

  test('pull sends the host and parses tasks', async () => {
    const { api, calls } = fakeApi({ tasks: [task({ id: 'x' })] });
    const client = makeCaClient(enabled, api);
    const tasks = await client.pull();
    expect(tasks).toHaveLength(1);
    expect(calls[0]).toEqual({ path: '/tasks/pull', query: { host: 'box-1' } });
  });

  test('update encodes the payload as base64url JSON in the data param', async () => {
    const { api, calls } = fakeApi();
    const client = makeCaClient(enabled, api);
    await client.update('ca-9', { status: 'done', totalTokens: 42 });
    expect(calls[0].path).toBe('/tasks/ca-9/update');
    const decoded = JSON.parse(Buffer.from(calls[0].query.data, 'base64url').toString('utf8'));
    expect(decoded).toMatchObject({ host: 'box-1', status: 'done', totalTokens: 42 });
  });

  test('pushData carries host + kind + encoded payload', async () => {
    const { api, calls } = fakeApi();
    const client = makeCaClient(enabled, api);
    await client.pushData('usage', { buckets: [], at: 'now' });
    expect(calls[0]).toMatchObject({ path: '/data', query: { host: 'box-1', kind: 'usage' } });
    expect(JSON.parse(Buffer.from(calls[0].query.data, 'base64url').toString('utf8'))).toEqual({
      buckets: [],
      at: 'now',
    });
  });
});

describe('resolveCaSync', () => {
  test('env vars enable sync and normalize the URL', async () => {
    const saved = {
      url: process.env.CA_SYNC_URL,
      key: process.env.CA_SYNC_API_KEY,
      host: process.env.CA_SYNC_HOST_ID,
    };
    process.env.CA_SYNC_URL = 'https://ca.example/';
    process.env.CA_SYNC_API_KEY = 'cak_abc';
    process.env.CA_SYNC_HOST_ID = 'studio';
    try {
      const s = await resolveCaSync();
      expect(s.enabled).toBe(true);
      expect(s.url).toBe('https://ca.example'); // trailing slash stripped
      expect(s.hostId).toBe('studio');
    } finally {
      process.env.CA_SYNC_URL = saved.url;
      process.env.CA_SYNC_API_KEY = saved.key;
      process.env.CA_SYNC_HOST_ID = saved.host;
    }
  });

  test('without an API key, sync stays disabled', async () => {
    const saved = { url: process.env.CA_SYNC_URL, key: process.env.CA_SYNC_API_KEY };
    process.env.CA_SYNC_URL = 'https://ca.example';
    delete process.env.CA_SYNC_API_KEY;
    try {
      expect((await resolveCaSync()).enabled).toBe(false);
    } finally {
      process.env.CA_SYNC_URL = saved.url;
      if (saved.key !== undefined) process.env.CA_SYNC_API_KEY = saved.key;
    }
  });
});
