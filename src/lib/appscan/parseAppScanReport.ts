/**
 * Parse the TEXT of an HCL AppScan / "AppScan on Cloud" (ASoC) security report
 * into structured stats — severity counts, scan technology (SAST/DAST/SCA/IAST),
 * the application name, and the per-issue-type breakdown — so a pipeline can roll
 * vulnerability data up into the dashboard DB without hand-written glue.
 *
 * Input is the extracted text layer (e.g. from cwip's `extractPdfText`), not the
 * PDF bytes — keeping this pure and dependency-free so it's fully testable.
 *
 * The real ASoC report layout (validated against sample SAST + DAST PDFs) carries
 * an explicit "Summary of security issues" block ("High severity issues: 73"), a
 * "Total security issues: N" line, a `Technology:` field, and a "Number of Issues"
 * table listing each issue type with its finding count. When that summary block is
 * present it is AUTHORITATIVE; the looser label↔count / flattened-table heuristics
 * are a fallback for other templates and synthetic text (and are NOT consulted
 * once the explicit summary is found, so a stray page number next to a severity
 * legend can't inject a phantom count).
 */

import { SEVERITY_RANK, VULN_SEVERITIES, type VulnIssueType, type VulnSeverity } from '../../shared/vulnerabilities';

export type Severity = VulnSeverity;
export type ScanType = 'SAST' | 'DAST' | 'SCA' | 'IAST';
/** A named issue category + its finding count (and best-effort severity). */
export type AppScanIssueType = VulnIssueType;

export const SEVERITIES = VULN_SEVERITIES;

export interface AppScanReport {
  /** Did the text look like an AppScan/ASoC report at all? */
  isAppScan: boolean;
  /** Application/scan name (or scanned host for DAST), when found. */
  application?: string;
  /** Scan technology, when identifiable. */
  scanType?: ScanType;
  /** Count of findings per severity (0 when not present). */
  severities: Record<Severity, number>;
  /** Per-issue-type breakdown ("SQL Injection" → 19), when the report lists one. */
  issueTypes: AppScanIssueType[];
  /** Total findings — the report's explicit "Total security issues" when present, else the sum. */
  total: number;
}

/** Markers that identify an AppScan / ASoC report (case-insensitive). */
const APPSCAN_MARKERS = [/appscan\s+on\s+cloud/i, /hcl\s+appscan/i, /\bappscan\b/i];

/** Does this text look like an AppScan / ASoC report? */
export function isAppScanReport(text: string): boolean {
  return APPSCAN_MARKERS.some((re) => re.test(text));
}

/** Detect the scan technology from the `Technology:` field, explicit acronyms, or spelled-out phases. */
export function detectScanType(text: string): ScanType | undefined {
  const tech = text.match(/\bTechnology\s*[:-]?\s*(SAST|DAST|SCA|IAST)\b/i);
  if (tech) return tech[1].toUpperCase() as ScanType;
  if (/\bSAST\b/.test(text) || /static\s+analysis/i.test(text)) return 'SAST';
  if (/\bDAST\b/.test(text) || /dynamic\s+analysis/i.test(text)) return 'DAST';
  if (/\bIAST\b/.test(text) || /interactive\s+analysis/i.test(text)) return 'IAST';
  if (/\bSCA\b/.test(text) || /software\s+composition/i.test(text)) return 'SCA';
  return undefined;
}

/** Trim a detected label value to its first meaningful segment (flattened text has no line breaks). */
function firstSegment(value: string): string | undefined {
  return (
    value
      .trim()
      // stop at a double-space, a newline, or the next labelled field that abuts it
      .split(/\s{2,}|\n|\s+(?:Technology|Report\s+created|This\s+report|Scan\s+Information|Port)\b/i)[0]
      .trim() || undefined
  );
}

/** Pull an application identity: the scanned host (DAST), else an "Application/Scan Name:" label. */
export function detectApplication(text: string): string | undefined {
  // DAST reports key off the scanned host — a single, reliable token.
  const host = text.match(/\bHost\s*[:-]\s*([A-Za-z0-9._-]+)/i);
  if (host) return host[1];
  const m = text.match(/(?:application|app|scan)\s*name\s*[:-]\s*(.+)/i) ?? text.match(/\bapplication\s*[:-]\s*(.+)/i);
  return m ? firstSegment(m[1]) : undefined;
}

const SEVERITY_WORD: Record<string, Severity> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  informational: 'informational',
};
const emptyCounts = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0, informational: 0 });

/**
 * Tally per-severity counts from the report text.
 *
 * PRIMARY (authoritative): the ASoC "Summary of security issues" block, where each
 * line reads "<Severity> severity issues: N". When ANY severity matches this shape
 * the summary is trusted verbatim and the looser fallbacks below are skipped.
 *
 * FALLBACK (other templates / synthetic text only): "Critical: 12" / "12 Critical"
 * label↔count pairs, then a flattened "Critical High Medium Low" header row
 * followed by a counts row. First plausible value per severity wins; missing → 0.
 */
export function tallySeverities(text: string): Record<Severity, number> {
  const counts = emptyCounts();
  const found: Record<Severity, boolean> = {
    critical: false,
    high: false,
    medium: false,
    low: false,
    informational: false,
  };

  const set = (sev: Severity, n: number) => {
    if (!found[sev] && Number.isFinite(n)) {
      counts[sev] = n;
      found[sev] = true;
    }
  };

  // PRIMARY — the explicit ASoC summary block.
  for (const m of text.matchAll(
    /\b(critical|high|medium|low|informational)\s+severity\s+issues?\s*[:-]?\s*(\d{1,7})\b/gi,
  )) {
    set(SEVERITY_WORD[m[1].toLowerCase()], Number(m[2]));
  }
  if (SEVERITIES.some((s) => found[s])) return counts; // authoritative — don't let fallbacks add noise

  // FALLBACK 1 — label → count / count → label, in document order. The label→count
  // separator stays on the same line ([ \t], not \s) so a severity word at a line
  // end isn't bound to a count that belongs to the next row.
  const pair =
    /(critical|high|medium|low|informational)[ \t]*[:-]?[ \t]*(\d{1,6})\b|(\d{1,6})[ \t]+(critical|high|medium|low|informational)\b/gi;
  for (const m of text.matchAll(pair)) {
    if (m[1]) set(SEVERITY_WORD[m[1].toLowerCase()], Number(m[2]));
    else if (m[4]) set(SEVERITY_WORD[m[4].toLowerCase()], Number(m[3]));
  }

  // FALLBACK 2 — a header row of severities followed by a row of counts.
  if (!['critical', 'high', 'medium', 'low'].every((s) => found[s as Severity])) {
    const header = text.match(/critical\s+high\s+medium\s+low/i);
    if (header) {
      const after = text.slice((header.index ?? 0) + header[0].length);
      const nums = after.match(/\d{1,6}/g);
      if (nums && nums.length >= 4) {
        (['critical', 'high', 'medium', 'low'] as Severity[]).forEach((s, i) => {
          set(s, Number(nums[i]));
        });
      }
    }
  }
  return counts;
}

/** The report's explicit "Total security issues: N", when present. */
export function detectTotal(text: string): number | undefined {
  const m = text.match(/Total\s+security\s+issues?\s*[:-]?\s*(\d{1,7})/i);
  return m ? Number(m[1]) : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Best-effort per-type severity: attribute each per-finding "Severity: X" to the
 * nearest preceding occurrence of a known issue-type name, then keep the worst per
 * type. Uses the authoritative type-name list as anchors (no fragile name regex),
 * so it degrades gracefully — a type with no attributable finding just keeps an
 * undefined severity. The counts (from the "Number of Issues" table) are exact;
 * this only enriches them.
 */
function attachSeverities(text: string, types: AppScanIssueType[]): void {
  if (!types.length) return;
  const findings: { pos: number; sev: Severity }[] = [];
  for (const m of text.matchAll(/\bSeverity\s*[:-]?\s*(Critical|High|Medium|Low|Informational)\b/gi)) {
    findings.push({ pos: m.index ?? 0, sev: m[1].toLowerCase() as Severity });
  }
  if (!findings.length) return;

  const occurrences = types.map((t) => {
    const positions: number[] = [];
    for (const m of text.matchAll(new RegExp(escapeRegExp(t.name), 'gi'))) positions.push(m.index ?? 0);
    return positions;
  });

  const worst: (Severity | undefined)[] = types.map(() => undefined);
  for (const f of findings) {
    let bestIdx = -1;
    let bestPos = -1;
    for (let i = 0; i < occurrences.length; i++) {
      for (const p of occurrences[i]) {
        if (p < f.pos && p > bestPos) {
          bestPos = p;
          bestIdx = i;
        }
      }
    }
    if (bestIdx >= 0) {
      const cur = worst[bestIdx];
      if (!cur || SEVERITY_RANK[f.sev] > SEVERITY_RANK[cur]) worst[bestIdx] = f.sev;
    }
  }
  types.forEach((t, i) => {
    if (worst[i]) t.severity = worst[i];
  });
}

/**
 * Parse the report's "Number of Issues" breakdown table into `{ name, count }`
 * pairs. The PDF text layer flattens the two-column table to "<Type words> <count>
 * <Type words> <count> …"; a token walk accumulates name words until a standalone
 * integer (the count), which is robust to type names that embed digits via a
 * hyphen (e.g. "SHA-1", whose "1" is not a standalone token) and to quoted/
 * parenthesised names. Bounded to the block before the "Issues - By …" section.
 */
export function parseIssueTypes(text: string): AppScanIssueType[] {
  const m = text.match(/Number of Issues\s+([\s\S]*?)(?:\d+\s+Issues\s*-\s*By|\bIssues\s*-\s*By\b|$)/i);
  if (!m) return [];
  const tokens = m[1].split(/\s+/).filter(Boolean);
  const types: AppScanIssueType[] = [];
  let nameTokens: string[] = [];
  for (const tok of tokens) {
    if (/^\d{1,6}$/.test(tok)) {
      if (nameTokens.length) {
        types.push({ name: nameTokens.join(' '), count: Number(tok) });
        nameTokens = [];
      }
      // a standalone number with no accumulated name is a stray page number — skip
    } else {
      nameTokens.push(tok);
    }
  }
  attachSeverities(text, types);
  return types;
}

/** Parse extracted AppScan report text into structured stats. */
export function parseAppScanReport(text: string): AppScanReport {
  const severities = tallySeverities(text);
  const issueTypes = parseIssueTypes(text);
  const total = detectTotal(text) ?? SEVERITIES.reduce((sum, s) => sum + severities[s], 0);
  return {
    isAppScan: isAppScanReport(text),
    application: detectApplication(text),
    scanType: detectScanType(text),
    severities,
    issueTypes,
    total,
  };
}
