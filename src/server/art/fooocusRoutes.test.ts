import { beforeAll, describe, expect, test } from 'bun:test';
import { loadConfig, saveConfig } from '../../lib/config';
import { handleFooocusApi } from './fooocusRoutes';

// Routing-level coverage of the tuning surface. RUBATO_HOME is isolated by the
// test preload, so /tuning round-trips a temp config. To test the live-API proxies
// deterministically (a real Fooocus may or may not be running on this machine), we
// point the backend URL at a dead port so they always take the graceful offline
// path. The start/stop/restart actions are NOT exercised here — they manage real OS
// processes and belong to the manager's own tests.

beforeAll(async () => {
  const cfg = await loadConfig();
  cfg.art = { ...cfg.art, url: 'http://127.0.0.1:1' }; // nothing listens → connection refused
  await saveConfig(cfg);
});

const url = (rest: string) => `http://localhost/api/art/fooocus${rest}`;
const get = (rest: string) => handleFooocusApi(`/api/art/fooocus${rest}`, new Request(url(rest)));
const post = (rest: string, body?: unknown) =>
  handleFooocusApi(
    `/api/art/fooocus${rest}`,
    new Request(url(rest), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

describe('handleFooocusApi routing', () => {
  test('GET /tuning returns the tuning state shape', async () => {
    const res = await get('/tuning');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.art).toBeDefined();
    expect(body.memory).toBeDefined();
    expect(Array.isArray(body.launchArgs)).toBe(true);
  });

  test('POST /tuning validates + persists and echoes the new state', async () => {
    const res = await post('/tuning', { art: { guidanceScale: 99 }, memory: { vram: 'low', fp16: true } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.art.guidanceScale).toBe(30); // clamped
    expect(body.memory.vram).toBe('low');
    expect(body.launchArgs).toContain('--always-low-vram');
  });

  test('POST /tuning with a non-JSON body is a 400', async () => {
    const res = await handleFooocusApi(
      '/api/art/fooocus/tuning',
      new Request(url('/tuning'), { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(400);
  });

  test('a non-GET/POST method on /tuning is a 405', async () => {
    const res = await handleFooocusApi('/api/art/fooocus/tuning', new Request(url('/tuning'), { method: 'PUT' }));
    expect(res.status).toBe(405);
  });

  test('GET /options returns the offline shape when the engine is unreachable', async () => {
    const res = await get('/options');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.offline).toBe(true);
    expect(body.models).toEqual([]);
    expect(body.styles).toEqual([]);
  });

  test('GET /stats always reports host memory (queue null when offline)', async () => {
    const res = await get('/stats');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.host.totalMb).toBeGreaterThan(0);
    expect(body.host.usedPct).toBeGreaterThanOrEqual(0);
    expect(body.queue).toBeNull();
  });

  test('POST /clean-vram returns a friendly not-reachable result when offline', async () => {
    const res = await post('/clean-vram');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/not reachable/i);
  });

  test('GET /clean-vram (wrong method) is a 405', async () => {
    const res = await get('/clean-vram');
    expect(res.status).toBe(405);
  });

  test('an unknown subpath is a 404', async () => {
    const res = await get('/nope');
    expect(res.status).toBe(404);
  });
});
