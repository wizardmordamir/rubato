/**
 * Filter a walked file list down to indexable source/text, and read it.
 *
 * Drops binaries (by extension and a NUL-byte sniff), oversized files, minified
 * bundles, source maps, and lockfiles. Honors optional per-app include/exclude
 * globs over the relative path. PDFs are the exception: their embedded text layer
 * is extracted (lazy cwip `extractPdfText`) so reports are indexable/ask-able.
 */

import { readFile } from 'node:fs/promises';
import { extractPdfText } from 'cwip/node';
import type { WalkedFile } from '../walkFiles';

/** Files larger than this are skipped — too big to embed/chunk usefully. */
export const MAX_FILE_BYTES = 512 * 1024;

/**
 * PDFs are the one "binary" we read (via cwip's lazy `extractPdfText`): their text
 * layer is much smaller than the raw bytes, so allow a bigger on-disk file but cap
 * the extracted text to the usual budget so chunking/embedding stays sane.
 */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Extensions that are binary/non-text and never worth indexing. */
const BINARY_EXTS = new Set([
  // images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'webp',
  'tiff',
  'svg',
  // fonts
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  // media
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'webm',
  'mov',
  'avi',
  'mkv',
  'flac',
  // archives / binaries
  'zip',
  'gz',
  'tar',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'pdf',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'o',
  'a',
  'class',
  'wasm',
  'onnx',
  'safetensors',
  'gguf',
  'pt',
  'pth',
  'h5',
  'npz',
  'parquet',
  // misc
  'ds_store',
  'lock',
]);

const LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
]);

function ext(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function looksBinaryName(name: string): boolean {
  return BINARY_EXTS.has(ext(name));
}

/** PDFs are binary on disk but we read their text layer — handled specially. */
export function isPdfName(name: string): boolean {
  return ext(name) === 'pdf';
}

/**
 * Extract a PDF's embedded text layer (lazy cwip backend, capped). Returns null
 * when the optional `unpdf` backend is absent, the file can't be parsed, or it
 * carries no text (e.g. a scanned-image PDF) — so a PDF is skipped gracefully
 * rather than breaking the indexer, exactly like a binary would be.
 */
export async function readPdfText(buf: Uint8Array): Promise<string | null> {
  try {
    const { text } = await extractPdfText(buf);
    const trimmed = text.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_FILE_BYTES ? trimmed.slice(0, MAX_FILE_BYTES) : trimmed;
  } catch {
    return null;
  }
}

export function looksMinified(name: string): boolean {
  return /\.min\.(js|css|mjs|cjs)$/i.test(name) || name.endsWith('.map');
}

export function isLockfile(name: string): boolean {
  return LOCKFILES.has(name);
}

/** True if any of the first 8KB is a NUL byte (a strong binary signal). */
export function hasNulByte(buf: Uint8Array): boolean {
  const end = Math.min(buf.byteLength, 8192);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

const GLOB_SPECIAL = /[.+^${}()|[\]\\?]/;

/** Match a relative path against a `*`/`**` glob (`*` = no slash, `**` = any). */
export function matchGlob(path: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'; // ** → any, including slashes
        i++;
      } else {
        re += '[^/]*'; // * → any, except slashes
      }
    } else if (GLOB_SPECIAL.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`).test(path);
}

export interface TextFileFilter {
  /** When set, only paths matching one of these globs are kept. */
  include?: string[];
  /** Paths matching any of these globs are dropped. */
  exclude?: string[];
}

function passesGlobs(relativePath: string, filter: TextFileFilter): boolean {
  if (filter.exclude?.some((g) => matchGlob(relativePath, g))) return false;
  if (filter.include?.length && !filter.include.some((g) => matchGlob(relativePath, g))) return false;
  return true;
}

export interface TextFile {
  relativePath: string;
  fullPath: string;
  content: string;
  /** Byte length of the file on disk. */
  bytes: number;
}

/** Read the subset of `files` that are indexable text, applying include/exclude globs. */
export async function readTextFiles(files: WalkedFile[], filter: TextFileFilter = {}): Promise<TextFile[]> {
  const out: TextFile[] = [];
  for (const f of files) {
    const base = f.relativePath.split('/').pop() ?? '';
    const isPdf = isPdfName(base);
    // PDFs are "binary" by extension but we read their text layer; every other
    // binary, minified bundle, and lockfile is still skipped.
    if ((looksBinaryName(base) && !isPdf) || looksMinified(base) || isLockfile(base)) continue;
    if (!passesGlobs(f.relativePath, filter)) continue;
    let buf: Buffer;
    try {
      buf = await readFile(f.fullPath);
    } catch {
      continue;
    }
    if (buf.byteLength === 0) continue;
    if (buf.byteLength > (isPdf ? MAX_PDF_BYTES : MAX_FILE_BYTES)) continue;
    // Capture the on-disk size up front: the PDF backend (pdf.js) detaches the
    // input buffer during extraction, after which `buf.byteLength` reads 0.
    const bytes = buf.byteLength;

    let content: string;
    if (isPdf) {
      const text = await readPdfText(buf);
      if (text === null) continue; // no text layer / backend absent → skip gracefully
      content = text;
    } else {
      if (hasNulByte(buf)) continue;
      content = buf.toString('utf8');
    }
    out.push({ relativePath: f.relativePath, fullPath: f.fullPath, content, bytes });
  }
  return out;
}
