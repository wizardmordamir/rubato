import { describe, expect, test } from 'bun:test';
import type { VulnerabilityRecord } from '../shared/vulnerabilities';
import { computeVulnStats } from './vulnStats';

const rec = (over: Partial<VulnerabilityRecord>): VulnerabilityRecord => ({
  id: 1,
  app: 'app',
  scanType: 'SAST',
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  informational: 0,
  total: 0,
  scannedAt: 0,
  ...over,
});

describe('computeVulnStats', () => {
  test('sums totals (incl. informational), counts apps, and lists apps per severity', () => {
    const stats = computeVulnStats([
      rec({ app: 'a', critical: 2, high: 1, total: 3 }),
      rec({ app: 'b', scanType: 'DAST', high: 4, low: 5, informational: 2, total: 11 }),
      rec({ app: 'c', total: 0 }),
    ]);
    expect(stats.apps).toBe(3);
    expect(stats.records).toBe(3);
    expect(stats.totals).toEqual({ critical: 2, high: 5, medium: 0, low: 5, informational: 2, total: 14 });
    expect(stats.appsBySeverity.critical).toEqual(['a']);
    expect(stats.appsBySeverity.high).toEqual(['a', 'b']);
    expect(stats.appsBySeverity.low).toEqual(['b']);
    expect(stats.appsBySeverity.informational).toEqual(['b']);
    expect(stats.scanTypes).toEqual(['DAST', 'SAST']);
  });

  test('vuln-free = apps whose every record sums to zero', () => {
    const stats = computeVulnStats([
      rec({ app: 'clean', total: 0 }),
      rec({ app: 'clean', scanType: 'DAST', total: 0 }),
      rec({ app: 'dirty', critical: 1, total: 1 }),
    ]);
    expect(stats.vulnFree).toEqual(['clean']);
  });

  test('an app with one clean + one dirty scan is NOT vuln-free', () => {
    const stats = computeVulnStats([
      rec({ app: 'mix', scanType: 'SAST', total: 0 }),
      rec({ app: 'mix', scanType: 'DAST', high: 2, total: 2 }),
    ]);
    expect(stats.vulnFree).toEqual([]);
  });

  test('empty input → zeroed stats', () => {
    expect(computeVulnStats([])).toEqual({
      apps: 0,
      records: 0,
      totals: { critical: 0, high: 0, medium: 0, low: 0, informational: 0, total: 0 },
      vulnFree: [],
      appsBySeverity: { critical: [], high: [], medium: [], low: [], informational: [] },
      scanTypes: [],
      sharedIssues: [],
    });
  });
});

describe('computeVulnStats — sharedIssues (cross-app comparison)', () => {
  test('groups issue types across apps; widest-spread first; apps sorted by count', () => {
    const stats = computeVulnStats([
      rec({
        app: 'alpha',
        high: 5,
        total: 5,
        issueTypes: [
          { name: 'SQL Injection', count: 3, severity: 'high' },
          { name: 'XSS', count: 2, severity: 'medium' },
        ],
      }),
      rec({
        app: 'beta',
        scanType: 'DAST',
        high: 1,
        total: 1,
        issueTypes: [{ name: 'SQL Injection', count: 1, severity: 'critical' }],
      }),
      rec({
        app: 'gamma',
        medium: 4,
        total: 4,
        issueTypes: [{ name: 'XSS', count: 4, severity: 'medium' }],
      }),
    ]);

    // SQL Injection (2 apps) and XSS (2 apps) outrank single-app types; both tie on
    // appCount=2, so volume breaks the tie (XSS total 6 > SQLi total 4).
    const types = stats.sharedIssues.map((i) => i.type);
    expect(types.slice(0, 2)).toEqual(['XSS', 'SQL Injection']);

    const sqli = stats.sharedIssues.find((i) => i.type === 'SQL Injection');
    expect(sqli?.appCount).toBe(2);
    expect(sqli?.totalCount).toBe(4);
    expect(sqli?.severity).toBe('critical'); // worst severity observed across apps
    expect(sqli?.apps.map((a) => a.app)).toEqual(['alpha', 'beta']); // sorted by count desc (3 > 1)

    const xss = stats.sharedIssues.find((i) => i.type === 'XSS');
    expect(xss?.apps.map((a) => a.app)).toEqual(['gamma', 'alpha']); // 4 > 2
  });

  test('sums a type appearing in two scans of the same app', () => {
    const stats = computeVulnStats([
      rec({ app: 'one', scanType: 'SAST', issueTypes: [{ name: 'SQL Injection', count: 2 }], high: 2, total: 2 }),
      rec({ app: 'one', scanType: 'DAST', issueTypes: [{ name: 'SQL Injection', count: 3 }], high: 3, total: 3 }),
    ]);
    const sqli = stats.sharedIssues.find((i) => i.type === 'SQL Injection');
    expect(sqli?.appCount).toBe(1);
    expect(sqli?.totalCount).toBe(5);
    expect(sqli?.apps).toEqual([{ app: 'one', scanType: 'SAST', count: 5 }]);
  });

  test('ignores zero-count / unnamed issue types', () => {
    const stats = computeVulnStats([
      rec({
        app: 'x',
        issueTypes: [
          { name: 'Empty', count: 0 },
          { name: '', count: 4 },
        ],
      }),
    ]);
    expect(stats.sharedIssues).toEqual([]);
  });
});
