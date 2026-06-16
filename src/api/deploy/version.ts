/**
 * Pure version helpers for correlating a deploy-list version to a Jenkins build.
 *
 * Reality check from real data: a release version like "1.1.13.739" does NOT
 * cleanly map to a Jenkins build. The trailing segment (739) is often off-by-one
 * from the build number (740), `RELEASE_VERSION` is frequently "latest", and the
 * build's SCM commit need not match the deploy-list commit. So build correlation
 * is deliberately best-effort enrichment — never a hard verification gate. The
 * trustworthy anchor is the Quay tag (see resolve.ts); these helpers just give
 * the resolver its candidates, in descending confidence.
 */

import { getBuildParam } from '../jenkins/filters';
import type { JenkinsBuild } from '../jenkins/types';

/** Numeric segments and the trailing segment (if numeric) of a dotted version. */
export function parseVersion(v: string): { segments: number[]; trailing: number | null } {
  const parts = v.split('.');
  const segments = parts.map((p) => Number.parseInt(p, 10)).filter((n) => Number.isFinite(n));
  const last = parts[parts.length - 1] ?? '';
  const trailing = /^\d+$/.test(last) ? Number.parseInt(last, 10) : null;
  return { segments, trailing };
}

/** The trailing segment as a candidate build number. Heuristic — caller flags it as low-confidence. */
export function buildNumberFromVersion(v: string): number | null {
  return parseVersion(v).trailing;
}

const DOTTED_VERSION = /\b(\d+\.\d+\.\d+(?:\.\d+)?)\b/;

/**
 * The version a build embeds, if it exposes one, else null. Tries (in order):
 *   1. a configured build parameter (e.g. IMAGE_VERSION) — ignoring "latest"
 *   2. a dotted version inside displayName / fullDisplayName
 * displayName is frequently just "#740" (no version) → returns null and the
 * resolver falls back to the build-number heuristic.
 */
export function versionFromBuild(build: JenkinsBuild, opts: { param?: string } = {}): string | null {
  if (opts.param) {
    const val = getBuildParam(build, opts.param);
    if (typeof val === 'string' && val && !/^latest$/i.test(val)) return val;
  }
  for (const name of [build.displayName, build.fullDisplayName]) {
    const m = name?.match(DOTTED_VERSION);
    if (m) return m[1];
  }
  return null;
}
