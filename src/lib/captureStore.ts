/**
 * On-disk storage for capture sessions, under `~/.rubato/captures/<id>/`:
 *   manifest.json   — the CaptureManifest (records + metadata)
 *   html/<seq>.html — the page HTML at each recorded moment
 *   shot/<seq>.<ext>— the screenshot at each moment
 * Persisting per-moment keeps memory bounded and survives a crash mid-session.
 * `bundleBytes` assembles a single shippable gzipped bundle from a session dir;
 * `importBundle` expands a bundle back into a session dir on the other machine.
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

const CAPTURES_DIR = resolve(RUBATO_HOME, 'captures');

/** A safe single-path-segment id (no traversal, no separators). */
function safeId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[-.]+/, '');
  if (!s) throw new Error('invalid capture id');
  return s;
}

export function captureDir(id: string): string {
  return resolve(CAPTURES_DIR, safeId(id));
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Split a `data:<mime>;base64,<data>` URL into bytes + a file extension. */
function decodeDataUrl(dataUrl: string): { bytes: Buffer; ext: string } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) return null;
  return { bytes: Buffer.from(m[2], 'base64'), ext: EXT_BY_MIME[m[1]] ?? 'bin' };
}

/**
 * Persist one capture moment's artifacts and return the record (entry + file
 * refs). Writes html/<seq>.html and shot/<seq>.<ext> under the session dir.
 */
export async function persistCaptureMoment(
  id: string,
  entry: CaptureEntry,
  html?: string,
  screenshot?: string,
): Promise<CaptureRecord> {
  const dir = captureDir(id);
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
}

export async function writeManifest(manifest: CaptureManifest): Promise<void> {
  const dir = captureDir(manifest.id);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function readManifest(id: string): Promise<CaptureManifest | null> {
  try {
    const raw = await readFile(resolve(captureDir(id), 'manifest.json'), 'utf8');
    return JSON.parse(raw) as CaptureManifest;
  } catch {
    return null;
  }
}

/**
 * Patch a stored session's editable metadata (label / description). Only the
 * provided keys change; a blank string clears the field. Returns the updated
 * summary, or null if the session doesn't exist.
 */
export async function updateCaptureMeta(
  id: string,
  patch: { label?: string; note?: string },
): Promise<CaptureSummary | null> {
  const manifest = await readManifest(id);
  if (!manifest) return null;
  if ('label' in patch) manifest.label = patch.label?.trim() || undefined;
  if ('note' in patch) manifest.note = patch.note?.trim() || undefined;
  await writeManifest(manifest);
  return summarizeManifest(manifest);
}

/** Every stored/imported capture, most-recent first. */
export async function listCaptures(): Promise<CaptureSummary[]> {
  let ids: string[];
  try {
    ids = await readdir(CAPTURES_DIR);
  } catch {
    return [];
  }
  const out: CaptureSummary[] = [];
  for (const id of ids) {
    try {
      if (!(await stat(captureDir(id))).isDirectory()) continue;
    } catch {
      continue;
    }
    const m = await readManifest(id);
    if (m) out.push(summarizeManifest(m));
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export async function deleteCapture(id: string): Promise<boolean> {
  try {
    await rm(captureDir(id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Read an artifact file's bytes (guarded to the session dir). For the viewer. */
export async function readCaptureArtifact(id: string, rel: string): Promise<Buffer | null> {
  if (rel.includes('..')) return null;
  const dir = captureDir(id);
  const abs = resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(`${dir}/`)) return null;
  try {
    return await readFile(abs);
  } catch {
    return null;
  }
}

/** Read a stored session's manifest + inline its artifacts into a CaptureBundle. */
async function assembleBundle(id: string): Promise<CaptureBundle | null> {
  const manifest = await readManifest(id);
  if (!manifest) return null;
  const artifacts: Record<string, string> = {};
  for (const r of manifest.records) {
    if (r.htmlFile) {
      const buf = await readCaptureArtifact(id, r.htmlFile);
      if (buf) artifacts[r.htmlFile] = buf.toString('utf8');
    }
    if (r.screenshotFile) {
      const buf = await readCaptureArtifact(id, r.screenshotFile);
      if (buf) {
        const ext = r.screenshotFile.split('.').pop() ?? 'jpg';
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        artifacts[r.screenshotFile] = `data:${mime};base64,${buf.toString('base64')}`;
      }
    }
  }
  return buildBundle(manifest, artifacts);
}

/** Assemble a single shippable gzipped bundle (file form) from a stored session. */
export async function bundleBytes(id: string): Promise<Uint8Array | null> {
  const bundle = await assembleBundle(id);
  return bundle ? serializeBundle(bundle) : null;
}

/**
 * Assemble a stored session as a compact, shareable STRING. With a `seed` the
 * string is AES-256-GCM encrypted (paste-into-email safe; the seed is required to
 * import it); without one it's compressed-only. The preferred transport.
 */
export async function bundleText(id: string, seed?: string): Promise<string | null> {
  const bundle = await assembleBundle(id);
  return bundle ? bundleToText(bundle, seed) : null;
}

/** Write a decoded bundle into a fresh session dir (renaming the id on collision). */
async function writeBundle(bundle: CaptureBundle): Promise<CaptureSummary> {
  let id = safeId(bundle.manifest.id || 'imported');
  let n = 1;
  while (await readManifest(id)) id = `${safeId(bundle.manifest.id || 'imported')}-${++n}`;

  const dir = captureDir(id);
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
}

/** Import a gzipped bundle (file form) → a fresh session dir. */
export async function importBundle(bytes: Uint8Array): Promise<CaptureSummary> {
  return writeBundle(parseBundle(bytes));
}

/** Import a shared bundle STRING (sealed needs its seed) → a fresh session dir. */
export async function importBundleText(token: string, seed?: string): Promise<CaptureSummary> {
  return writeBundle(bundleFromText(token, seed));
}
