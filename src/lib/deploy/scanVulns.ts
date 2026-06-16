/**
 * Summarize a Quay/Clair security scan into per-severity counts. Pure: takes the
 * QuaySecurity response shape and rolls up its features' vulnerabilities.
 *
 * Built to the standard Clair response (status + data.Layer.Features[].
 * Vulnerabilities[].Severity). Severities are normalized to a canonical, ordered
 * set so the same image scanned by slightly different Clair versions tallies the
 * same way.
 */

import type { QuaySecurity } from '../../api/quay';

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Negligible', 'Unknown'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface VulnSummary {
  /** Scan status from Quay ("scanned", "queued", "unsupported", ...). */
  status: string;
  /** True only when status === "scanned" (counts are meaningful). */
  scanned: boolean;
  counts: Record<Severity, number>;
  total: number;
}

function normalizeSeverity(raw: string | undefined): Severity {
  const s = (raw ?? '').toLowerCase();
  if (s.startsWith('crit')) return 'Critical';
  if (s.startsWith('high')) return 'High';
  if (s.startsWith('med')) return 'Medium';
  if (s.startsWith('low')) return 'Low';
  if (s.startsWith('neg') || s.startsWith('info')) return 'Negligible';
  return 'Unknown';
}

const emptyCounts = (): Record<Severity, number> =>
  Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;

/** Roll a Clair security response up into per-severity counts. */
export function summarizeVulnerabilities(security: QuaySecurity): VulnSummary {
  const counts = emptyCounts();
  const scanned = security.status === 'scanned';
  if (scanned) {
    for (const feature of security.data?.Layer?.Features ?? []) {
      for (const vuln of feature.Vulnerabilities ?? []) {
        counts[normalizeSeverity(vuln.Severity)]++;
      }
    }
  }
  const total = SEVERITIES.reduce((n, s) => n + counts[s], 0);
  return { status: security.status, scanned, counts, total };
}

/** Compact one-line severity tally, e.g. "Critical=1 High=3 Medium=0 …". */
export function formatVulnCounts(summary: VulnSummary): string {
  return SEVERITIES.map((s) => `${s}=${summary.counts[s]}`).join(' ');
}
