import { describe, expect, test } from 'bun:test';
import type { QuaySecurity } from '../../api/quay';
import { formatVulnCounts, summarizeVulnerabilities } from './scanVulns';

const scanned: QuaySecurity = {
  status: 'scanned',
  data: {
    Layer: {
      Features: [
        { Name: 'openssl', Vulnerabilities: [{ Severity: 'High' }, { Severity: 'Critical' }] },
        { Name: 'glibc', Vulnerabilities: [{ Severity: 'high' }, { Severity: 'Medium' }, { Severity: 'Negligible' }] },
        { Name: 'clean-pkg' }, // no Vulnerabilities array
      ],
    },
  },
};

describe('summarizeVulnerabilities', () => {
  test('rolls features up into normalized per-severity counts', () => {
    const s = summarizeVulnerabilities(scanned);
    expect(s.scanned).toBe(true);
    expect(s.counts).toMatchObject({ Critical: 1, High: 2, Medium: 1, Negligible: 1, Low: 0, Unknown: 0 });
    expect(s.total).toBe(5);
  });

  test('unscanned status yields zero counts and scanned=false', () => {
    const s = summarizeVulnerabilities({ status: 'queued' });
    expect(s.scanned).toBe(false);
    expect(s.total).toBe(0);
  });

  test('unknown/blank severities fall into Unknown', () => {
    const s = summarizeVulnerabilities({
      status: 'scanned',
      data: { Layer: { Features: [{ Vulnerabilities: [{ Severity: 'weird' }, {}] }] } },
    });
    expect(s.counts.Unknown).toBe(2);
  });

  test('formatVulnCounts renders an ordered one-liner', () => {
    expect(formatVulnCounts(summarizeVulnerabilities(scanned))).toBe(
      'Critical=1 High=2 Medium=1 Low=0 Negligible=1 Unknown=0',
    );
  });
});
