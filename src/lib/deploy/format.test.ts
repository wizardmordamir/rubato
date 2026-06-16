import { describe, expect, test } from 'bun:test';
import type { VerifyReport } from '../../api/deploy/types';
import { toCsv } from '../output';
import {
  imageLineToText,
  type ShaListItem,
  shaListToText,
  shaListWithDatesToText,
  VERIFY_COLUMNS,
  verifyReportToRows,
} from './format';

const items: ShaListItem[] = [
  { app: 'team/my-app', version: '1.1.13.739', commit: 'a1c32a44', sha256: '617b85', date: '6-9 7:49' },
  { app: 'org/two', version: '2.0.0', sha256: 'deadbeef' },
];

describe('text emitters', () => {
  test('block layout', () => {
    expect(shaListToText(items)).toBe(
      'team/my-app 1.1.13.739\ncommit a1c32a44\nsha256:617b85\n\norg/two 2.0.0\ncommit -\nsha256:deadbeef',
    );
  });
  test('dated layout adds (date) and commit: colon', () => {
    const out = shaListWithDatesToText(items).split('\n');
    expect(out[0]).toBe('team/my-app 1.1.13.739 (6-9 7:49)');
    expect(out[1]).toBe('commit: a1c32a44');
  });
  test('single-line image layout', () => {
    expect(imageLineToText(items).split('\n')[0]).toBe('team/my-app 1.1.13.739 sha256:617b85');
  });
});

describe('verifyReportToRows', () => {
  const report: VerifyReport = {
    timestamp: '2026-06-12T00:00:00.000Z',
    summary: { totalEntries: 1, passed: 1, failed: 0, totalIssues: 0, totalWarnings: 0 },
    results: [
      {
        app: 'team/my-app',
        version: '1.1.13.739',
        commit: 'a1c32a44',
        sha256: '617b85',
        status: 'PASS',
        issues: [],
        warnings: [],
        metadata: {
          verificationTimestamp: '2026-06-12T00:00:00.000Z',
          jenkinsData: {
            buildNumber: 740,
            buildTimestamp: 0,
            buildTimestampIso: '',
            buildUrl: '',
            buildResult: 'SUCCESS',
            matchStrategy: 'buildNumber',
          },
          quayData: { tagName: '1.1.13.739', tagSize: 579787144 },
          gitData: { commitAuthor: 'Jane Dev', commitMessage: 'jenkins-logging' },
        },
      },
    ],
  };

  test('flattens fields and converts image size to MB', () => {
    const rows = verifyReportToRows(report);
    expect(rows[0]).toMatchObject({
      app: 'team/my-app',
      status: 'PASS',
      build: '#740',
      buildResult: 'SUCCESS',
      quayTag: '1.1.13.739',
      imageMB: '552.93',
      gitAuthor: 'Jane Dev',
    });
  });

  test('renders to CSV via the shared helper', () => {
    const csv = toCsv(verifyReportToRows(report), VERIFY_COLUMNS).split('\n');
    expect(csv[0]).toBe(VERIFY_COLUMNS.join(','));
    expect(csv[1]).toContain('team/my-app');
  });
});
