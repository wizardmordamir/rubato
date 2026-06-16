/**
 * Guards for tools that read an app's files. Tools are read-only by design, but
 * a model can still request a path that escapes the repo or names a secret —
 * both are refused here. The denylist matters most in restricted environments,
 * where the agent must never surface credentials.
 */

import { isAbsolute, relative, resolve } from 'node:path';

/** Paths we never read regardless of where they sit (secrets / credential stores). */
const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/i, // .env, .env.local, .env.production
  /\.(pem|key|pfx|p12|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)\.(npmrc|netrc|pgpass)$/i,
  /(^|\/)\.git\//, // internal git state
  /(^|\/)\.ssh\//,
  /(^|\/)secrets?\b/i,
];

export function isSecretPath(relPath: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(relPath));
}

export type ResolvedPath = { ok: true; abs: string; rel: string } | { ok: false; error: string };

/**
 * Resolve a model-supplied path against the repo root. Refuses traversal/escape
 * (`..`, absolute paths outside root) and secret files. Pure string resolution;
 * callers should still realpath-check before reading to catch symlink escape.
 */
export function resolveRepoPath(root: string, requested: string): ResolvedPath {
  const cleaned = requested.trim();
  if (!cleaned) return { ok: false, error: 'no path given' };
  const abs = resolve(root, cleaned);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: 'path is outside the app and was refused' };
  }
  if (isSecretPath(rel)) return { ok: false, error: 'that file is a secret/credential and was refused' };
  return { ok: true, abs, rel };
}

/** Translate a simple glob (`*`, `**`, `?`) into a RegExp for filtering file lists. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
