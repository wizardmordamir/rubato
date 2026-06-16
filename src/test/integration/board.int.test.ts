/**
 * Integration: the Board API through `route()` — task CRUD/validation, image
 * upload (type + size guards, generated names), the safe image-serve route
 * (only server-generated name shapes resolve — no traversal surface).
 */

import { describe, expect, test } from 'bun:test';
import type { BoardTask } from '../../shared/board';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

async function fetchRoute(path: string, init?: RequestInit): Promise<Response> {
  const { route } = await import('../../server/router');
  return route(new Request(`http://localhost${path}`, init));
}

const TASK = {
  title: 'wire the deploy check',
  description: 'verify shas after deploy',
  notes: 'see verifyshas',
  links: ['https://example.com/ticket/1'],
  images: [],
  status: 'ready',
  position: 1,
};

describe('board task CRUD', () => {
  test('create → list → move to in-progress → delete', async () => {
    const created = (await (await apiPost('/api/board', TASK)).json()) as BoardTask;
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('ready');

    const list = (await (await apiGet('/api/board')).json()) as BoardTask[];
    expect(list.some((t) => t.id === created.id)).toBe(true);

    const moved = (await (
      await apiPost('/api/board', { ...created, status: 'in-progress', position: 2.5 })
    ).json()) as BoardTask;
    expect(moved.id).toBe(created.id);
    expect(moved.status).toBe('in-progress');
    expect(moved.position).toBe(2.5);

    const deleted = await (await fetchRoute(`/api/board/${created.id}`, { method: 'DELETE' })).json();
    expect(deleted).toEqual({ deleted: true });
  });

  test('rejects a missing title and a bogus status', async () => {
    expect((await apiPost('/api/board', { ...TASK, title: ' ' })).status).toBe(400);
    expect((await apiPost('/api/board', { ...TASK, status: 'someday' })).status).toBe(400);
  });
});

describe('board images', () => {
  const upload = (name: string, bytes: BlobPart = 'fake-image-bytes') => {
    const form = new FormData();
    form.set('file', new File([bytes], name));
    return fetchRoute('/api/board/upload', { method: 'POST', body: form });
  };

  test('upload stores under a generated name and serves back', async () => {
    const res = await upload('screenshot.png');
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/api\/board\/images\/[0-9a-f-]{36}\.png$/);

    const img = await fetchRoute(url);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(await img.text()).toBe('fake-image-bytes');
  });

  test('rejects non-image extensions and oversized files', async () => {
    expect((await upload('notes.txt')).status).toBe(400);
    expect((await upload('huge.png', new Uint8Array(11 * 1024 * 1024))).status).toBe(413);
  });

  test('the serve route only accepts generated-name shapes (no traversal)', async () => {
    for (const name of ['../../config.json', '..%2F..%2Fconfig.json', 'evil.png.sh', 'no-uuid.png']) {
      const res = await fetchRoute(`/api/board/images/${name}`);
      expect(res.status).toBe(404);
    }
  });
});
