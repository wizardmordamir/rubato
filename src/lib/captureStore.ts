/**
 * Storage for capture sessions — pluggable, like the automation + run stores.
 *
 * The default ({@link createFileCaptureStore}) keeps each session under
 * `<dir>/<id>/`:
 *   manifest.json   — the CaptureManifest (records + metadata)
 *   html/<seq>.html — the page HTML at each recorded moment
 *   shot/<seq>.<ext>— the screenshot at each moment
 * Persisting per-moment keeps memory bounded and survives a crash mid-session.
 * `bundleBytes`/`bundleText` assemble a single shippable bundle from a session;
 * `importBundle*` expand one back into a session on the other machine.
 *
 * A friend app can inject its own {@link CaptureStore} via
 * `automationsPlugin({ captureStore })` — or, most commonly, just relocate the
 * directory: `createFileCaptureStore(resolve(appDataDir("my-app"), "captures"))`.
 * rubato's own server keeps captures under `RUBATO_HOME`.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CaptureBundle, CaptureEntry, CaptureManifest, CaptureRecord, CaptureSummary } from '../shared/capture';
import {
  buildBundle,
  bundleFromText,
  bundleToText,
  parseBundle,
  serializeBundle,
  summarizeManifest,
} from './captureBundle';
import { RUBATO_HOME } from './config';

/**
 * Pluggable persistence for capture sessions (manifests + per-moment HTML/screenshot
 * artifacts + shippable bundles). Implement this to keep captures off local disk;
 * the default is {@link createFileCaptureStore}.
 */
export interface CaptureStore {
  /** Persist one capture moment's artifacts; returns the record (entry + file refs). */
  persistMoment(id: string, entry: CaptureEntry, html?: string, screenshot?: string): Promise<CaptureRecord>;
  /** Write (or overwrite) a session's manifest. */
  writeManifest(manifest: CaptureManifest): Promise<void>;
  /** Read a session's manifest, or null if absent. */
  readManifest(id: string): Promise<CaptureManifest | null>;
  /** Patch a session's editable metadata (label/note); null if it doesn't exist. */
  updateMeta(id: string, patch: { label?: string; note?: string }): Promise<CaptureSummary | null>;
  /** Every stored/imported session, most-recent first. */
  list(): Promise<CaptureSummary[]>;
  /** Delete a session and its artifacts; true if it existed. */
  delete(id: string): Promise<boolean>;
  /** Read one artifact file's bytes (guarded to the session), for the viewer. */
  readArtifact(id: string, rel: string): Promise<Buffer | null>;
  /** Assemble a shippable gzipped bundle (file form) from a stored session. */
  bundleBytes(id: string): Promise<Uint8Array | null>;
  /** Assemble a stored session as a compact, optionally-sealed shareable string. */
  bundleText(id: string, seed?: string): Promise<string | null>;
  /** Import a gzipped bundle (file form) into a fresh session. */
  importBundle(bytes: Uint8Array): Promise<CaptureSummary>;
  /** Import a shared bundle string (sealed needs its seed) into a fresh session. */
  importBundleText(token: string, seed?: string): Promise<CaptureSummary>;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** A safe single-path-segment id (no traversal, no separators). */
function safeId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[-.]+/, '');
  if (!s) throw new Error('invalid capture id');
  return s;
}

/** Split a `data:<mime>;base64,<data>` URL into bytes + a file extension. */
function decodeDataUrl(dataUrl: string): { bytes: Buffer; ext: string } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) return null;
  return { bytes: Buffer.from(m[2], 'base64'), ext: EXT_BY_MIME[m[1]] ?? 'bin' };
}

/**
 * File-backed capture store: each session under `<baseDir>/<id>/`. rubato's default
 * backend. `baseDir` defaults to `~/.rubato/captures` (the monolith); a friend app
 * passes its own (e.g. `resolve(appDataDir("my-app"), "captures")`).
 */
export function createFileCaptureStore(baseDir: string = resolve(RUBATO_HOME, 'captures')): CaptureStore {
  const dirFor = (id: string) => resolve(baseDir, safeId(id));

  const readManifest: CaptureStore['readManifest'] = async (id) => {
    try {
      return JSON.parse(await readFile(resolve(dirFor(id), 'manifest.json'), 'utf8')) as CaptureManifest;
    } catch {
      return null;
    }
  };

  const writeManifest: CaptureStore['writeManifest'] = async (manifest) => {
    const dir = dirFor(manifest.id);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  };

  const readArtifact: CaptureStore['readArtifact'] = async (id, rel) => {
    if (rel.includes('..')) return null;
    const dir = dirFor(id);
    const abs = resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(`${dir}/`)) return null;
    try {
      return await readFile(abs);
    } catch {
      return null;
    }
  };

  const persistMoment: CaptureStore['persistMoment'] = async (id, entry, html, screenshot) => {
    const dir = dirFor(id);
    const record: CaptureRecord = { ...entry };
    if (html != null) {
      const rel = `html/${entry.seq}.html`;
      await mkdir(resolve(dir, 'html'), { recursive: true });
      await writeFile(resolve(dir, rel), html, 'utf8');
      record.htmlFile = rel;
    }
    if (screenshot) {
      const decoded = decodeDataUrl(screenshot);
      if (decoded) {
        const rel = `shot/${entry.seq}.${decoded.ext}`;
        await mkdir(resolve(dir, 'shot'), { recursive: true });
        await writeFile(resolve(dir, rel), decoded.bytes);
        record.screenshotFile = rel;
      }
    }
    return record;
  };

  const updateMeta: CaptureStore['updateMeta'] = async (id, patch) => {
    const manifest = await readManifest(id);
    if (!manifest) return null;
    if ('label' in patch) manifest.label = patch.label?.trim() || undefined;
    if ('note' in patch) manifest.note = patch.note?.trim() || undefined;
    await writeManifest(manifest);
    return summarizeManifest(manifest);
  };

  const list: CaptureStore['list'] = async () => {
    let ids: string[];
    try {
      ids = await readdir(baseDir);
    } catch {
      return [];
    }
    const out: CaptureSummary[] = [];
    for (const id of ids) {
      try {
        if (!(await stat(dirFor(id))).isDirectory()) continue;
      } catch {
        continue;
      }
      const m = await readManifest(id);
      if (m) out.push(summarizeManifest(m));
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  };

  const del: CaptureStore['delete'] = async (id) => {
    try {
      await rm(dirFor(id), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };

  /** Read a stored session's manifest + inline its artifacts into a CaptureBundle. */
  const assembleBundle = async (id: string): Promise<CaptureBundle | null> => {
    const manifest = await readManifest(id);
    if (!manifest) return null;
    const artifacts: Record<string, string> = {};
    for (const r of manifest.records) {
      if (r.htmlFile) {
        const buf = await readArtifact(id, r.htmlFile);
        if (buf) artifacts[r.htmlFile] = buf.toString('utf8');
      }
      if (r.screenshotFile) {
        const buf = await readArtifact(id, r.screenshotFile);
        if (buf) {
          const ext = r.screenshotFile.split('.').pop() ?? 'jpg';
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
          artifacts[r.screenshotFile] = `data:${mime};base64,${buf.toString('base64')}`;
        }
      }
    }
    return buildBundle(manifest, artifacts);
  };

  /** Write a decoded bundle into a fresh session dir (renaming the id on collision). */
  const writeBundle = async (bundle: CaptureBundle): Promise<CaptureSummary> => {
    let id = safeId(bundle.manifest.id || 'imported');
    let n = 1;
    while (await readManifest(id)) id = `${safeId(bundle.manifest.id || 'imported')}-${++n}`;

    const dir = dirFor(id);
    await mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(bundle.artifacts)) {
      if (rel.includes('..')) continue; // never write outside the session dir
      const abs = resolve(dir, rel);
      if (abs !== dir && !abs.startsWith(`${dir}/`)) continue;
      await mkdir(resolve(abs, '..'), { recursive: true });
      const decoded = content.startsWith('data:') ? decodeDataUrl(content) : null;
      if (decoded) await writeFile(abs, decoded.bytes);
      else await writeFile(abs, content, 'utf8');
    }
    const manifest: CaptureManifest = { ...bundle.manifest, id };
    await writeManifest(manifest);
    return summarizeManifest(manifest);
  };

  return {
    persistMoment,
    writeManifest,
    readManifest,
    updateMeta,
    list,
    delete: del,
    readArtifact,
    bundleBytes: async (id) => {
      const bundle = await assembleBundle(id);
      return bundle ? serializeBundle(bundle) : null;
    },
    bundleText: async (id, seed) => {
      const bundle = await assembleBundle(id);
      return bundle ? bundleToText(bundle, seed) : null;
    },
    importBundle: async (bytes) => writeBundle(parseBundle(bytes)),
    importBundleText: async (token, seed) => writeBundle(bundleFromText(token, seed)),
  };
}

/** The process-default capture store (`~/.rubato/captures/`). */
export const captureStore: CaptureStore = createFileCaptureStore();

// Back-compat free functions — rubato's own server calls these and get the default
// file store. A friend app injects its own backend via `automationsPlugin({ captureStore })`.
export const persistCaptureMoment = (id: string, entry: CaptureEntry, html?: string, screenshot?: string) =>
  captureStore.persistMoment(id, entry, html, screenshot);
export const writeManifest = (manifest: CaptureManifest) => captureStore.writeManifest(manifest);
export const readManifest = (id: string) => captureStore.readManifest(id);
export const updateCaptureMeta = (id: string, patch: { label?: string; note?: string }) =>
  captureStore.updateMeta(id, patch);
export const listCaptures = () => captureStore.list();
export const deleteCapture = (id: string) => captureStore.delete(id);
export const readCaptureArtifact = (id: string, rel: string) => captureStore.readArtifact(id, rel);
export const bundleBytes = (id: string) => captureStore.bundleBytes(id);
export const bundleText = (id: string, seed?: string) => captureStore.bundleText(id, seed);
export const importBundle = (bytes: Uint8Array) => captureStore.importBundle(bytes);
export const importBundleText = (token: string, seed?: string) => captureStore.importBundleText(token, seed);
