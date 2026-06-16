import { describe, expect, test } from 'bun:test';
import { saveAutomation } from '../lib/automations';
import { writeManifest } from '../lib/captureStore';
import type { CaptureManifest } from '../shared/capture';
import { route } from './router';

const post = (path: string, body: unknown) =>
  route(new Request(`http://x${path}`, { method: 'POST', body: JSON.stringify(body) }));

describe('automation routes', () => {
  test('GET /api/automations returns an array', async () => {
    const res = await route(new Request('http://x/api/automations'));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('GET /api/automation-runs returns an array', async () => {
    const res = await route(new Request('http://x/api/automation-runs'));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('POST /api/automations without name/steps is a 400', async () => {
    expect((await post('/api/automations', {})).status).toBe(400);
    expect((await post('/api/automations', { name: 'x' })).status).toBe(400);
  });

  test('POST /api/automations/run without id or automation is a 404', async () => {
    expect((await post('/api/automations/run', {})).status).toBe(404);
  });

  test('GET an unknown automation 404s', async () => {
    const res = await route(new Request('http://x/api/automations/does-not-exist-xyz'));
    expect(res.status).toBe(404);
  });

  describe('POST /api/automations/:id/steps-from-capture', () => {
    test('lifts a captured flow into steps when the steps list is empty', async () => {
      const capId = 'cap-gen-test';
      const manifest: CaptureManifest = {
        id: capId,
        startUrl: 'https://app/login',
        startedAt: 0,
        records: [
          { seq: 0, ts: 0, url: 'https://app/login', kind: 'start' },
          {
            seq: 1,
            ts: 1,
            url: 'https://app/login',
            kind: 'action',
            action: 'fill',
            target: { kind: 'id', value: 'email' },
            params: { value: 'me' },
          },
          {
            seq: 2,
            ts: 2,
            url: 'https://app/login',
            kind: 'action',
            action: 'click',
            target: { kind: 'role', value: 'button', name: 'Sign in' },
          },
        ],
      };
      await writeManifest(manifest);
      const saved = await saveAutomation({
        name: 'gen from capture',
        steps: [],
        capture: { id: capId, count: 0, startedAt: 0 },
      });

      const res = await post(`/api/automations/${saved.id}/steps-from-capture`, {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as { automation: { steps: unknown[] }; generated: number };
      expect(body.generated).toBe(2);
      expect(body.automation.steps).toHaveLength(2);
    });

    test('re-derives steps even when the flow already has steps (overwrites)', async () => {
      const capId = 'cap-regen-test';
      const manifest: CaptureManifest = {
        id: capId,
        startUrl: 'https://app/login',
        startedAt: 0,
        records: [
          { seq: 0, ts: 0, url: 'https://app/login', kind: 'start' },
          {
            seq: 1,
            ts: 1,
            url: 'https://app/login',
            kind: 'action',
            action: 'fill',
            target: { kind: 'id', value: 'email' },
            params: { value: 'me' },
          },
          {
            seq: 2,
            ts: 2,
            url: 'https://app/login',
            kind: 'action',
            action: 'click',
            target: { kind: 'role', value: 'button', name: 'Sign in' },
          },
        ],
      };
      await writeManifest(manifest);
      // A flow that ALREADY has (hand-edited) steps — re-deriving must replace them.
      const saved = await saveAutomation({
        name: 'regen from capture',
        steps: [{ id: 's-old', action: 'goto', params: { url: 'https://app/stale' } }],
        capture: { id: capId, count: 0, startedAt: 0 },
      });
      expect(saved.steps).toHaveLength(1);

      const res = await post(`/api/automations/${saved.id}/steps-from-capture`, {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as { automation: { steps: { id: string }[] }; generated: number };
      expect(body.generated).toBe(2);
      expect(body.automation.steps).toHaveLength(2);
      // The stale hand-edited step is gone — the capture is the source of truth.
      expect(body.automation.steps.some((s) => s.id === 's-old')).toBe(false);
    });

    test('400s when the automation has no capture to lift from', async () => {
      const saved = await saveAutomation({ name: 'no capture flow', steps: [] });
      const res = await post(`/api/automations/${saved.id}/steps-from-capture`, {});
      expect(res.status).toBe(400);
    });

    test('404s for an unknown automation', async () => {
      expect((await post('/api/automations/does-not-exist-xyz/steps-from-capture', {})).status).toBe(404);
    });
  });

  test('session routes validate their inputs without launching a browser', async () => {
    expect((await post('/api/session/launch', {})).status).toBe(400);
    expect((await post('/api/session/test-selector', {})).status).toBe(400);
    expect((await post('/api/session/nope', {})).status).toBe(404);
    // GET /api/session/url is safe with no active session.
    const url = await route(new Request('http://x/api/session/url'));
    expect(url.status).toBe(200);
    expect((await url.json()) as { url: string }).toEqual({ url: '' });
  });
});
