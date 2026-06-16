/**
 * Capture / data-gathering API — the artifact backend for the Browser builder's
 * capture track. The live capture *session* lives in server/browserSession.ts now
 * (recording + capturing share one headed browser); this file only stores, reads,
 * lifts, ships, and converts the recorded sessions.
 *
 *   POST   /api/capture/import   <gzip bundle>    → import a shipped bundle → summary
 *   GET    /api/capture                           → CaptureSummary[] (stored sessions)
 *   GET    /api/capture/:id                       → the manifest (records)
 *   PATCH  /api/capture/:id       { label?, note? } → edit a stored session's label / description → summary
 *   GET    /api/capture/:id/export                → the gzipped, shippable bundle (download)
 *   GET    /api/capture/:id/artifact?path=html/0.html → one artifact, inline (HTML sandboxed / image)
 *   GET    /api/capture/:id/draft                 → lift to an UNSAVED editable builder draft (+capture ref)
 *   POST   /api/capture/:id/automation { name? }  → save the recording as a rerunnable Automation
 *   DELETE /api/capture/:id                       → { deleted }
 */

import { type AutomationStore, automationStore as defaultAutomationStore } from '../lib/automations';
import { type CaptureStore, captureStore as defaultCaptureStore } from '../lib/captureStore';
import { captureToAutomation } from '../lib/captureToAutomation';
import type { RunSpeed } from '../shared/pacing';
import { json, jsonError, readJsonBody } from './http';

const CONTENT_TYPE: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export async function handleCaptureApi(
  pathname: string,
  req: Request,
  stores: { captures?: CaptureStore; automations?: AutomationStore } = {},
): Promise<Response> {
  const store = stores.captures ?? defaultCaptureStore;
  const automations = stores.automations ?? defaultAutomationStore;
  // The live capture session is now part of the unified build session
  // (server/browserSession.ts, driven from the Browser builder). This handler keeps
  // only the artifact backend: list / read / draft / export / import / convert.

  // ── import a shared bundle STRING (sealed needs its seed) — the preferred transport ──
  if (pathname === '/api/capture/import-text') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const b = await readJsonBody<{ token?: string; seed?: string }>(req);
    if (!b?.token?.trim()) return jsonError('token (the bundle string) required', 400);
    try {
      return json(await store.importBundleText(b.token, b.seed));
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err), 400);
    }
  }

  // ── import a shipped bundle (raw gzip body) ──
  if (pathname === '/api/capture/import') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    try {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length === 0) return jsonError('empty body — POST the bundle bytes', 400);
      return json(await store.importBundle(bytes));
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err), 400);
    }
  }

  // ── stored sessions ──
  if (pathname === '/api/capture') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return json(await store.list());
  }

  if (pathname.startsWith('/api/capture/')) {
    const rest = pathname.slice('/api/capture/'.length);

    // Export as a compact shareable STRING (optionally sealed with a seed) — preferred.
    if (rest.endsWith('/export-text')) {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      const id = decodeURIComponent(rest.slice(0, -'/export-text'.length));
      const b = await readJsonBody<{ seed?: string }>(req);
      const token = await store.bundleText(id, b?.seed);
      return token ? json({ token }) : jsonError('capture not found', 404);
    }

    if (rest.endsWith('/export')) {
      const id = decodeURIComponent(rest.slice(0, -'/export'.length));
      const bytes = await store.bundleBytes(id);
      if (!bytes) return jsonError('capture not found', 404);
      // Bun accepts a Uint8Array body at runtime; the DOM lib's BodyInit is stricter.
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          'content-type': 'application/gzip',
          'content-disposition': `attachment; filename="${id}.capture.gz"`,
        },
      });
    }

    // Lift a recorded capture into an UNSAVED automation draft (editable in the
    // builder) — the builder loads it, the user edits, then Save promotes it to a
    // real automation that keeps its capture track. This is what makes captures
    // editable without a destructive migration.
    if (rest.endsWith('/draft')) {
      if (req.method !== 'GET') return jsonError('use GET', 405);
      const id = decodeURIComponent(rest.slice(0, -'/draft'.length));
      const manifest = await store.readManifest(id);
      if (!manifest) return jsonError('capture not found', 404);
      const draft = captureToAutomation(manifest);
      return json({
        ...draft,
        // Prefer the capture's label as the flow name when it has one.
        name: manifest.label?.trim() || draft.name,
        capture: {
          id: manifest.id,
          count: manifest.records.length,
          startedAt: manifest.startedAt,
          stoppedAt: manifest.stoppedAt,
        },
      });
    }

    // Turn a recorded capture into a rerunnable Automation (one goto/click/fill
    // step per recorded moment) and save it to the automation store.
    if (rest.endsWith('/automation')) {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      const id = decodeURIComponent(rest.slice(0, -'/automation'.length));
      const manifest = await store.readManifest(id);
      if (!manifest) return jsonError('capture not found', 404);
      const b = await readJsonBody<{ name?: string; smartWaits?: RunSpeed }>(req);
      const automation = await automations.save(captureToAutomation(manifest, b?.name, b?.smartWaits ?? 'off'));
      return json(automation);
    }

    if (rest.endsWith('/artifact')) {
      const id = decodeURIComponent(rest.slice(0, -'/artifact'.length));
      const path = new URL(req.url).searchParams.get('path') ?? '';
      const buf = await store.readArtifact(id, path);
      if (!buf) return jsonError('artifact not found', 404);
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const headers: Record<string, string> = {
        'content-type': CONTENT_TYPE[ext] ?? 'application/octet-stream',
        'content-disposition': `inline; filename="${path.split('/').pop() ?? 'artifact'}"`,
      };
      // Captured pages are foreign HTML — sandbox them so they can't run/script.
      if (ext === 'html') headers['content-security-policy'] = 'sandbox';
      return new Response(buf as unknown as BodyInit, { headers });
    }

    const id = decodeURIComponent(rest);
    if (req.method === 'DELETE') return json({ deleted: await store.delete(id) });
    if (req.method === 'GET') {
      const manifest = await store.readManifest(id);
      return manifest ? json(manifest) : jsonError('capture not found', 404);
    }
    // Edit a stored session's label / description.
    if (req.method === 'PATCH') {
      const b = await readJsonBody<{ label?: string; note?: string }>(req);
      const summary = await store.updateMeta(id, b ?? {});
      return summary ? json(summary) : jsonError('capture not found', 404);
    }
    return jsonError('use GET, PATCH or DELETE', 405);
  }

  return jsonError(`not found: ${pathname}`, 404);
}
