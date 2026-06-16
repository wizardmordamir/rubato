/**
 * The capture API reads/writes through an injected {@link CaptureStore} — the seam a
 * friend app uses to keep capture sessions off local disk (or just relocate the
 * directory). A pure in-memory store proves the injection without touching the FS.
 */

import { describe, expect, test } from 'bun:test';
import { summarizeManifest } from '../lib/captureBundle';
import type { CaptureStore } from '../lib/captureStore';
import type { CaptureManifest } from '../shared/capture';
import { handleCaptureApi } from './captureRoutes';

function memCaptureStore(): CaptureStore & { map: Map<string, CaptureManifest> } {
  const map = new Map<string, CaptureManifest>();
  return {
    map,
    writeManifest: async (m) => {
      map.set(m.id, m);
    },
    readManifest: async (id) => map.get(id) ?? null,
    list: async () => [...map.values()].sort((a, b) => b.startedAt - a.startedAt).map(summarizeManifest),
    delete: async (id) => map.delete(id),
    updateMeta: async (id, p) => {
      const m = map.get(id);
      if (!m) return null;
      if (p.label !== undefined) m.label = p.label?.trim() || undefined;
      return summarizeManifest(m);
    },
    persistMoment: async (_id, entry) => ({ ...entry }),
    readArtifact: async () => null,
    bundleBytes: async () => null,
    bundleText: async () => null,
    importBundle: async () => {
      throw new Error('not supported in test store');
    },
    importBundleText: async () => {
      throw new Error('not supported in test store');
    },
  };
}

const cap = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);

describe('handleCaptureApi storage injection', () => {
  test('GET /api/capture lists from the injected capture store', async () => {
    const store = memCaptureStore();
    await store.writeManifest({ id: 'cap-1', startedAt: 1, records: [] });
    const res = await handleCaptureApi('/api/capture', cap('/api/capture'), { captures: store });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }[]).map((c) => c.id)).toEqual(['cap-1']);
  });

  test('GET /api/capture/:id reads the manifest from the injected store', async () => {
    const store = memCaptureStore();
    await store.writeManifest({ id: 'cap-2', startedAt: 2, records: [] });
    const res = await handleCaptureApi('/api/capture/cap-2', cap('/api/capture/cap-2'), { captures: store });
    expect(res.status).toBe(200);
    expect(((await res.json()) as CaptureManifest).id).toBe('cap-2');
  });

  test('DELETE /api/capture/:id removes from the injected store', async () => {
    const store = memCaptureStore();
    await store.writeManifest({ id: 'cap-3', startedAt: 3, records: [] });
    const res = await handleCaptureApi('/api/capture/cap-3', cap('/api/capture/cap-3', { method: 'DELETE' }), {
      captures: store,
    });
    expect(await res.json()).toEqual({ deleted: true });
    expect(store.map.has('cap-3')).toBe(false);
  });
});
