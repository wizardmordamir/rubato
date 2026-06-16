/**
 * Pure roll-up over stored vulnerability records — the dashboard math, kept
 * dependency-free and testable apart from the DB. Answers the use-case-4
 * questions: totals per severity, which apps carry a given severity, which apps
 * are vulnerability-free, the scan types present, and — for "find which apps have
 * the same problems so I can fix them together" — the cross-app issue-type
 * roll-up (`sharedIssues`).
 */

import {
  SEVERITY_RANK,
  type SharedIssue,
  VULN_SEVERITIES,
  type VulnerabilityRecord,
  type VulnSeverity,
  type VulnStats,
} from '../shared/vulnerabilities';

export function computeVulnStats(records: VulnerabilityRecord[]): VulnStats {
  const totals = { critical: 0, high: 0, medium: 0, low: 0, informational: 0, total: 0 };
  const appsBySeverity: Record<VulnSeverity, Set<string>> = {
    critical: new Set(),
    high: new Set(),
    medium: new Set(),
    low: new Set(),
    informational: new Set(),
  };
  const apps = new Set<string>();
  const scanTypes = new Set<string>();
  const appTotals = new Map<string, number>();

  // Accumulator for the cross-app issue-type roll-up, keyed by issue-type name.
  type Agg = {
    type: string;
    severity?: VulnSeverity;
    apps: Map<string, { scanType: string; count: number }>;
    total: number;
  };
  const byType = new Map<string, Agg>();

  for (const r of records) {
    apps.add(r.app);
    if (r.scanType) scanTypes.add(r.scanType);
    appTotals.set(r.app, (appTotals.get(r.app) ?? 0) + r.total);
    for (const sev of VULN_SEVERITIES) {
      totals[sev] += r[sev];
      if (r[sev] > 0) appsBySeverity[sev].add(r.app);
    }
    totals.total += r.total;

    for (const it of r.issueTypes ?? []) {
      if (!it?.name || !(it.count > 0)) continue;
      let agg = byType.get(it.name);
      if (!agg) {
        agg = { type: it.name, severity: it.severity, apps: new Map(), total: 0 };
        byType.set(it.name, agg);
      }
      // Keep the worst severity observed for the type across apps.
      if (it.severity && (!agg.severity || SEVERITY_RANK[it.severity] > SEVERITY_RANK[agg.severity])) {
        agg.severity = it.severity;
      }
      // Sum within an app (an app could have the same type from SAST + DAST).
      const prev = agg.apps.get(r.app);
      agg.apps.set(r.app, { scanType: prev?.scanType ?? r.scanType, count: (prev?.count ?? 0) + it.count });
      agg.total += it.count;
    }
  }

  // Vuln-free: apps that appear in a scan but whose every record sums to zero.
  const vulnFree = [...appTotals.entries()].filter(([, t]) => t === 0).map(([app]) => app);

  const sharedIssues: SharedIssue[] = [...byType.values()]
    .map((agg) => ({
      type: agg.type,
      severity: agg.severity,
      apps: [...agg.apps.entries()]
        .map(([app, v]) => ({ app, scanType: v.scanType, count: v.count }))
        .sort((a, b) => b.count - a.count || a.app.localeCompare(b.app)),
      appCount: agg.apps.size,
      totalCount: agg.total,
    }))
    // Most widespread problems first (shared across the most apps), then by volume,
    // then by severity — so "what should I fix everywhere" floats to the top.
    .sort(
      (a, b) =>
        b.appCount - a.appCount ||
        b.totalCount - a.totalCount ||
        (b.severity ? SEVERITY_RANK[b.severity] : 0) - (a.severity ? SEVERITY_RANK[a.severity] : 0) ||
        a.type.localeCompare(b.type),
    );

  return {
    apps: apps.size,
    records: records.length,
    totals,
    vulnFree: vulnFree.sort(),
    appsBySeverity: {
      critical: [...appsBySeverity.critical].sort(),
      high: [...appsBySeverity.high].sort(),
      medium: [...appsBySeverity.medium].sort(),
      low: [...appsBySeverity.low].sort(),
      informational: [...appsBySeverity.informational].sort(),
    },
    scanTypes: [...scanTypes].sort(),
    sharedIssues,
  };
}
