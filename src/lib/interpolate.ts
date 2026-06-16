/**
 * Variable substitution for automation steps, built on cwip's `interpolateWith`
 * (the generic `${name}` engine). This module keeps only the rubato semantics:
 * which sources a name resolves from, and which substitutions count as secrets.
 *
 * `${VAR}` resolves from per-run overrides (the preload form / pipeline vars
 * bag) first, then the process env / ~/.rubato/.env (via optionalEnv) — both
 * are treated as secrets and the resolved value is flagged `redacted` so the
 * interpreter never leaks it into step events or the run DB. `${scraped.NAME}`
 * resolves from the run's scrape bag, and `${run.dir}` from the per-run working
 * directory (neither is a secret).
 */

import { interpolateWith } from 'cwip';
import { optionalEnv } from '../api/env';

export interface InterpolateCtx {
  /** name → value captured by `scrape` steps earlier in the run. */
  scraped: Record<string, string>;
  /** name → value supplied for this run (preload form / pipeline bag). Checked
   * before env; treated as secret (redacted) since it often holds credentials. */
  vars?: Record<string, string>;
  /** The per-run working directory, exposed as `${run.dir}`. */
  dir?: string;
}

export interface Interpolated {
  value: string;
  /** True if any substitution pulled from a var/env (i.e. potentially a secret). */
  redacted: boolean;
}

const SCRAPED = 'scraped.';

/** Public (non-secret) sources are namespaced; everything else that resolves is a var/env secret. */
const isSecretName = (name: string): boolean => !name.startsWith(SCRAPED) && name !== 'run.dir';

export function interpolate(input: string, ctx: InterpolateCtx): Interpolated {
  const { value, used } = interpolateWith(input, (key) => {
    if (key.startsWith(SCRAPED)) return ctx.scraped[key.slice(SCRAPED.length)] ?? '';
    // `${run.dir}` (and future run.* channels) — a known path, never a secret.
    if (key === 'run.dir') return ctx.dir ?? '';
    return ctx.vars?.[key] ?? optionalEnv(key);
  });
  return { value, redacted: used.some(isSecretName) };
}

/**
 * Resolve a bare environment-variable NAME (a `valueMode: "env"` value) to its
 * value — a per-run override first (preload form / pipeline bag), else the
 * process env / ~/.rubato/.env. Always flagged `redacted`: the resolved value is
 * a secret and must never reach logs or the run DB.
 */
export function resolveEnvVar(name: string, vars?: Record<string, string>): Interpolated {
  const key = name.trim();
  return { value: vars?.[key] ?? optionalEnv(key) ?? '', redacted: true };
}

/** Replace every occurrence of `secret` in `text` with `***` (skip empties). */
export function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('***');
}
