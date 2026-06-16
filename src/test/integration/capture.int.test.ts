/**
 * Integration: the capture import/export/view API through `route()` — the half
 * that runs on THIS machine (ship a bundle back, inspect it). The live recording
 * (headed browser) isn't exercised here; this proves a bundle imports, lists,
 * serves its artifacts, round-trips through export, and deletes.
 */

import { describe, expect, test } from 'bun:test';
import { buildBundle, parseBundle, serializeBundle } from '../../lib/captureBundle';
import type { CaptureManifest, CaptureSummary } from '../../shared/capture';
import { apiGet, apiPatch, apiPost, useHarness } from '../index';

useHarness();

async function call(path: string, method = 'GET', body?: Uint8Array): Promise<Response> {
  const { route } = await import('../../server/router');
  const init: RequestInit = { method };
  if (body) {
    init.body = body as unknown as BodyInit; // Bun accepts Uint8Array; DOM BodyInit is stricter
    init.headers = { 'content-type': 'application/gzip' };
  }
  return route(new Request(`http://localhost${path}`, init));
}

const manifest: CaptureManifest = {
  id: 'cap-itest',
  label: 'jenkins screens',
  startedAt: 1,
  stoppedAt: 2,
  records: [
    {
      seq: 0,
      ts: 1,
      url: 'https://jenkins/build',
      kind: 'start',
      htmlFile: 'html/0.html',
      screenshotFile: 'shot/0.jpg',
    },
    {
      seq: 1,
      ts: 2,
      url: 'https://jenkins/build',
      kind: 'action',
      action: 'fill',
      target: { kind: 'css', value: 'input[name="value"]' },
      params: { value: '1.2.3' },
      htmlFile: 'html/1.html',
    },
  ],
};
const artifacts = {
  'html/0.html': '<html><body>start</body></html>',
  'html/1.html': "<form><input name='value'></form>",
  'shot/0.jpg': 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
};
const bundle = serializeBundle(buildBundle(manifest, artifacts));

describe('capture import → list → view → export → delete', () => {
  test('round-trips a shipped bundle', async () => {
    const imported = (await (await call('/api/capture/import', 'POST', bundle)).json()) as CaptureSummary;
    expect(imported.count).toBe(2);
    expect(imported.label).toBe('jenkins screens');

    const list = (await (await apiGet('/api/capture')).json()) as CaptureSummary[];
    expect(list.some((c) => c.id === imported.id)).toBe(true);

    const m = (await (await apiGet(`/api/capture/${imported.id}`)).json()) as CaptureManifest;
    expect(m.records).toHaveLength(2);
    expect(m.records[1].action).toBe('fill');

    // HTML artifact serves as sandboxed text/html.
    const htmlRes = await call(`/api/capture/${imported.id}/artifact?path=html/1.html`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type')).toContain('text/html');
    expect(htmlRes.headers.get('content-security-policy')).toBe('sandbox');
    expect(await htmlRes.text()).toContain("name='value'");

    // Screenshot artifact serves as an image.
    const shotRes = await call(`/api/capture/${imported.id}/artifact?path=shot/0.jpg`);
    expect(shotRes.headers.get('content-type')).toBe('image/jpeg');

    // Export round-trips back to the same records + artifacts.
    const exp = await call(`/api/capture/${imported.id}/export`);
    expect(exp.headers.get('content-type')).toBe('application/gzip');
    const back = parseBundle(new Uint8Array(await exp.arrayBuffer()));
    expect(back.manifest.records).toHaveLength(2);
    expect(back.artifacts['html/0.html']).toBe('<html><body>start</body></html>');

    expect(await (await call(`/api/capture/${imported.id}`, 'DELETE')).json()).toEqual({ deleted: true });
    expect((await apiGet(`/api/capture/${imported.id}`)).status).toBe(404);
  });

  test('lifts a capture into an editable draft (steps + capture ref) — /draft', async () => {
    const imported = (await (await call('/api/capture/import', 'POST', bundle)).json()) as CaptureSummary;

    const draft = (await (await apiGet(`/api/capture/${imported.id}/draft`)).json()) as {
      name: string;
      startUrl?: string;
      steps: { action: string }[];
      capture?: { id: string; count: number };
    };
    // `start` is dropped; the recorded `fill` becomes an editable step.
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0].action).toBe('fill');
    expect(draft.startUrl).toBe('https://jenkins/build');
    // Carries the capture track so a Save keeps the timeline.
    expect(draft.capture?.id).toBe(imported.id);
    expect(draft.capture?.count).toBe(2);
    // Prefers the capture's label as the flow name.
    expect(draft.name).toBe('jenkins screens');

    expect((await apiGet('/api/capture/nope/draft')).status).toBe(404);

    await call(`/api/capture/${imported.id}`, 'DELETE');
  });

  test('exports + imports a SEALED shareable string (seed required)', async () => {
    const src = (await (await call('/api/capture/import', 'POST', bundle)).json()) as CaptureSummary;

    // Export as a sealed string.
    const { token } = (await (await apiPost(`/api/capture/${src.id}/export-text`, { seed: 's3cret' })).json()) as {
      token: string;
    };
    expect(token.startsWith('rbz1_')).toBe(true); // encrypted
    expect(token).not.toContain('jenkins'); // content hidden

    // Wrong seed → import fails (400).
    expect((await apiPost('/api/capture/import-text', { token, seed: 'nope' })).status).toBe(400);
    // No seed → fails too.
    expect((await apiPost('/api/capture/import-text', { token })).status).toBe(400);

    // Right seed → imports to a fresh session with the same moments.
    const imported = (await (
      await apiPost('/api/capture/import-text', { token, seed: 's3cret' })
    ).json()) as CaptureSummary;
    expect(imported.count).toBe(2);
    expect(imported.label).toBe('jenkins screens');

    await call(`/api/capture/${src.id}`, 'DELETE');
    await call(`/api/capture/${imported.id}`, 'DELETE');
  });

  test('edits a stored session label + description via PATCH', async () => {
    const imported = (await (await call('/api/capture/import', 'POST', bundle)).json()) as CaptureSummary;
    expect(imported.note).toBeUndefined();

    // Add a description and rename the label; the summary reflects both.
    const updated = (await (
      await apiPatch(`/api/capture/${imported.id}`, { label: 'renamed', note: 'deploy walkthrough, prod box' })
    ).json()) as CaptureSummary;
    expect(updated.label).toBe('renamed');
    expect(updated.note).toBe('deploy walkthrough, prod box');

    // It persists onto the manifest (so the viewer + exported bundle carry it).
    const m = (await (await apiGet(`/api/capture/${imported.id}`)).json()) as CaptureManifest;
    expect(m.note).toBe('deploy walkthrough, prod box');

    // A blank value clears the field; an omitted field is left untouched.
    const cleared = (await (await apiPatch(`/api/capture/${imported.id}`, { note: '  ' })).json()) as CaptureSummary;
    expect(cleared.note).toBeUndefined();
    expect(cleared.label).toBe('renamed');

    // Unknown session → 404.
    expect((await apiPatch('/api/capture/nope', { note: 'x' })).status).toBe(404);

    await call(`/api/capture/${imported.id}`, 'DELETE');
  });

  test('rejects a non-bundle import + an artifact path-traversal', async () => {
    expect((await call('/api/capture/import', 'POST', new TextEncoder().encode('not gzip'))).status).toBe(400);
    const imported = (await (await call('/api/capture/import', 'POST', bundle)).json()) as CaptureSummary;
    const bad = await call(`/api/capture/${imported.id}/artifact?path=../../manifest.json`);
    expect(bad.status).toBe(404);
    await call(`/api/capture/${imported.id}`, 'DELETE');
  });
});
