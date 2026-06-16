/**
 * Wire types for the Vulnerabilities view — per-app security-scan stats parsed
 * from AppScan/ASoC reports (see src/lib/appscan + the `appscan-pdf` pipeline
 * script) and rolled up for dashboards. Pure types (no runtime imports) so the
 * UI can import via `@shared/vulnerabilities` and the pure parser can reuse the
 * severity vocabulary without pulling in a dependency.
 */

export type VulnSeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational';
/** Worst → least severe, the canonical display/iteration order. */
export const VULN_SEVERITIES: VulnSeverity[] = ['critical', 'high', 'medium', 'low', 'informational'];

/** Sort weight (higher = worse) for ranking issue types / picking a record's headline severity. */
export const SEVERITY_RANK: Record<VulnSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  informational: 1,
};

/**
 * A named issue category in a scan (e.g. "SQL Injection") and how many findings
 * it had. `severity` is the worst severity observed for the type when the report
 * makes it derivable (best-effort) — the cross-app comparison keys on `name`.
 */
export interface VulnIssueType {
  name: string;
  count: number;
  severity?: VulnSeverity;
}

/**
 * Deploy pipelines whose presence on a registered app means its code is built &
 * deployed — and therefore where its security scans actually run. Importing a scan
 * offers to associate it with one of these apps (see `DeployApp`).
 */
export const DEPLOY_PIPELINES = ['jenkins', 'harness'] as const;
export type DeployPipeline = (typeof DEPLOY_PIPELINES)[number];

/**
 * A registered app that deploys via Jenkins or Harness — a candidate to associate
 * an imported scan with. `deploysVia` is the subset of {@link DEPLOY_PIPELINES} the
 * app uses (why it's a candidate).
 */
export interface DeployApp {
  /** Registry app name (the value stored as a record's `linkedApp`). */
  name: string;
  /** Which deploy pipelines the app uses — jenkins and/or harness. */
  deploysVia: DeployPipeline[];
  /** Registry group (folder) for display grouping, if any. */
  group?: string | null;
}

/** One stored scan result, latest per (app, scanType). */
export interface VulnerabilityRecord {
  id: number;
  app: string;
  /** "SAST" | "DAST" | "SCA" | "IAST" | "" (unknown). */
  scanType: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
  total: number;
  /** Named issue categories + their finding counts (the report's breakdown). */
  issueTypes?: VulnIssueType[];
  /** The report file this came from, if any (an upload filename or run-dir name). */
  sourceFile?: string;
  /** Server-stored report file id (served inline via …/report) when a PDF was imported. */
  reportName?: string;
  /**
   * Registry app (by name) this scan is associated with — the deployed app whose
   * Jenkins/Harness pipeline the scan came from. Set after import via …/link.
   */
  linkedApp?: string;
  /** Parsed report payload (free-form), if stored. */
  raw?: unknown;
  /** When the scan was recorded (ms-epoch). */
  scannedAt: number;
}

/** Upsert payload (one scan result for an app). */
export interface VulnerabilityInput {
  app: string;
  scanType?: string;
  critical?: number;
  high?: number;
  medium?: number;
  low?: number;
  informational?: number;
  issueTypes?: VulnIssueType[];
  sourceFile?: string;
  reportName?: string;
  /** Registry app this scan deploys from (a Jenkins/Harness app); see `VulnerabilityRecord.linkedApp`. */
  linkedApp?: string;
  raw?: unknown;
  scannedAt?: number;
}

/**
 * One issue type seen across apps — the "which apps share this problem so I can
 * fix them together" roll-up. `apps` is sorted by count desc.
 */
export interface SharedIssue {
  type: string;
  /** Worst severity observed for this type across the apps that report it. */
  severity?: VulnSeverity;
  apps: { app: string; scanType: string; count: number }[];
  /** Distinct apps affected. */
  appCount: number;
  /** Findings of this type summed across all apps. */
  totalCount: number;
}

/** Aggregate roll-up over the stored records (computed server-side). */
export interface VulnStats {
  /** Distinct apps with at least one record. */
  apps: number;
  /** Number of stored scan records. */
  records: number;
  /** Summed counts across every record. */
  totals: { critical: number; high: number; medium: number; low: number; informational: number; total: number };
  /** Apps whose every scan has zero findings. */
  vulnFree: string[];
  /** For each severity, the apps that have ≥1 finding of it (sorted). */
  appsBySeverity: Record<VulnSeverity, string[]>;
  /** Distinct scan types present. */
  scanTypes: string[];
  /** Issue types seen in the records, sorted by # of apps affected then total count. */
  sharedIssues: SharedIssue[];
}

/** GET /api/vulnerabilities response. */
export interface VulnerabilitiesResponse {
  records: VulnerabilityRecord[];
  stats: VulnStats;
}
