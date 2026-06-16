/**
 * Compact, optionally-encrypted codec for turning bytes/strings into a single
 * text token (and back). Shared by `doencode`/`dodecode`, but generic enough to
 * reuse anywhere a small, transport-safe encoding is needed.
 *
 * Pipeline:  bytes → brotli compress → [AES-256-GCM if a key] → base64
 *
 * Brotli beats gzip on text size; base64 keeps tokens line/whitespace-safe. With
 * a key (derived from a user seed via scrypt) the payload is encrypted and
 * authenticated, so a wrong seed fails loudly instead of yielding garbage. With
 * no key it's just compression — smaller, not secret.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = 32; // AES-256

export interface CodecKey {
  /** 32-byte AES key derived from the seed; omit for compression-only. */
  key?: Buffer;
}

function compress(data: Buffer): Buffer {
  return brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
}

function decompress(data: Buffer): Buffer {
  return brotliDecompressSync(data);
}

/** A fresh random salt for a single encode run (stored in the archive header). */
export function newSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/** Derive the AES key from a user seed + salt (scrypt). */
export function deriveKey(seed: string, salt: Buffer): Buffer {
  return scryptSync(seed, salt, KEY_BYTES);
}

/** Encode bytes to a base64 token (compressed, and encrypted when a key is given). */
export function encodeBytes(data: Buffer, opts: CodecKey = {}): string {
  const compressed = compress(data);
  if (!opts.key) return compressed.toString('base64');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', opts.key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Reverse of encodeBytes. Throws if encrypted and the key (seed) is wrong. */
export function decodeToBytes(token: string, opts: CodecKey = {}): Buffer {
  const raw = Buffer.from(token, 'base64');
  if (!opts.key) return decompress(raw);

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', opts.key, iv);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decompress(compressed);
}

export function encodeString(text: string, opts: CodecKey = {}): string {
  return encodeBytes(Buffer.from(text, 'utf-8'), opts);
}

export function decodeString(token: string, opts: CodecKey = {}): string {
  return decodeToBytes(token, opts).toString('utf-8');
}

// --- archive header (first line of an encoded file; self-describing) ---

const HEADER_PREFIX = '#rubato-encode';

export interface ArchiveHeader {
  version: number;
  encrypted: boolean;
  /** Base64 salt, present only when encrypted. */
  salt?: string;
}

export function buildHeader(header: ArchiveHeader): string {
  const parts = [HEADER_PREFIX, `v${header.version}`, 'codec=brotli+base64', `encrypted=${header.encrypted}`];
  if (header.encrypted && header.salt) parts.push(`salt=${header.salt}`);
  return parts.join(' ');
}

/** Parse the header line, or null if it isn't a rubato-encode header. */
export function parseHeader(line: string): ArchiveHeader | null {
  if (!line.startsWith(HEADER_PREFIX)) return null;
  const tokens = line.trim().split(/\s+/);
  const kv = new Map<string, string>();
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq !== -1) kv.set(t.slice(0, eq), t.slice(eq + 1));
  }
  const versionToken = tokens[1] ?? 'v1';
  return {
    version: Number(versionToken.replace(/^v/, '')) || 1,
    encrypted: kv.get('encrypted') === 'true',
    salt: kv.get('salt'),
  };
}
