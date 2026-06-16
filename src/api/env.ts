/**
 * Env helpers for service clients.
 *
 * Secrets (e.g. JENKINS_API_TOKEN) live in ~/.rubato/.env so commands work the
 * same no matter which directory they're invoked from. Lookups check the real
 * process environment first, then that file. File parsing + caching is cwip's
 * `loadEnvFile`; this module is the rubato-specific layer (which file, lookup
 * order, the rubato-init hint in errors).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { clearEnvFileCache, loadEnvFile } from 'cwip/node';
import { ENV_FILE } from '../lib/config';

/** Valid POSIX-ish env var name. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Test/refresh hook: drop the cached ~/.rubato/.env contents. */
export function clearEnvCache(): void {
  clearEnvFileCache(ENV_FILE);
}

/**
 * A copy of the parsed ~/.rubato/.env map (key→value). Used by the diagnostics
 * redactor as a secret-value source — every value in here is a credential, so
 * any occurrence of one in logged data gets masked.
 */
export function rubatoEnvMap(): Record<string, string> {
  return { ...loadEnvFile(ENV_FILE) };
}

function lookup(name: string): string | undefined {
  return process.env[name] ?? loadEnvFile(ENV_FILE)[name];
}

/** Read a required env var (process env or ~/.rubato/.env), with a clear error. */
export function requireEnv(name: string): string {
  const value = lookup(name);
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. Add it to ~/.rubato/.env (run rubato-init).`);
  }
  return value;
}

/** Read an optional env var, falling back to the given default (or undefined). */
export function optionalEnv(name: string, fallback?: string): string | undefined {
  return lookup(name) ?? fallback;
}

/**
 * Upsert a `NAME=value` line in ~/.rubato/.env (creating the file if absent) and
 * drop the cache so the new value is visible immediately. Used to save a fetched
 * value (e.g. a session JWT) so automations/pipelines can reference it as
 * `${NAME}`. Throws on an invalid var name. The value is written verbatim on one
 * line, so newlines are stripped (JWTs/tokens are single-line).
 */
export function setEnvVar(name: string, value: string): void {
  if (!ENV_NAME_RE.test(name)) {
    throw new Error(`invalid env var name "${name}" (expected ${ENV_NAME_RE})`);
  }
  const line = `${name}=${value.replace(/[\r\n]+/g, ' ').trim()}`;
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const lines = existing.length > 0 ? existing.split('\n') : [];
  const idx = lines.findIndex((l) => l.replace(/^\s*export\s+/, '').startsWith(`${name}=`));
  if (idx >= 0) {
    lines[idx] = line;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(line);
  }
  mkdirSync(dirname(ENV_FILE), { recursive: true });
  writeFileSync(ENV_FILE, `${lines.join('\n')}\n`);
  clearEnvCache();
}
