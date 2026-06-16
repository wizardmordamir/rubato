/**
 * Pure formatters for deploy lists and verification reports.
 *
 * The text emitters reproduce the three list layouts (block / dated / single-line)
 * so generated lists read the way users expect. The report formatter turns a
 * VerifyReport into Rows for the shared toTable/toCsv helpers.
 */

import type { VerifyReport } from '../../api/deploy/types';
import type { Row } from '../output';

/** Minimal shape needed to render a list line. */
export interface ShaListItem {
  app: string;
  version: string;
  commit?: string;
  sha256: string;
  date?: string;
}

const sha = (s: string) => `sha256:${s}`;

/** Block layout: `app version` / `commit <c>` / `sha256:<s>`, entries blank-separated. */
export function shaListToText(items: ShaListItem[]): string {
  return items
    .map((it) => [`${it.app} ${it.version}`, `commit ${it.commit ?? '-'}`, sha(it.sha256)].join('\n'))
    .join('\n\n');
}

/** Dated layout: `app version (date)` / `commit: <c>` / `sha256:<s>`. */
export function shaListWithDatesToText(items: ShaListItem[]): string {
  return items
    .map((it) => {
      const header = it.date ? `${it.app} ${it.version} (${it.date})` : `${it.app} ${it.version}`;
      return [header, `commit: ${it.commit ?? '-'}`, sha(it.sha256)].join('\n');
    })
    .join('\n\n');
}

/** Single-line image layout: `app version sha256:<s>`. */
export function imageLineToText(items: ShaListItem[]): string {
  return items.map((it) => `${it.app} ${it.version} ${sha(it.sha256)}`).join('\n');
}

/** Columns for the verification report table/CSV. */
export const VERIFY_COLUMNS = [
  'app',
  'version',
  'status',
  'issues',
  'warnings',
  'commit',
  'sha256',
  'build',
  'buildResult',
  'quayTag',
  'imageMB',
  'gitAuthor',
  'gitDate',
  'gitMessage',
  'detail',
];

/** Flatten a report's results into Rows for toTable/toCsv. */
export function verifyReportToRows(report: VerifyReport): Row[] {
  return report.results.map((r) => {
    const j = r.metadata.jenkinsData;
    const q = r.metadata.quayData;
    const g = r.metadata.gitData;
    return {
      app: r.app,
      version: r.version,
      status: r.status,
      issues: r.issues.length,
      warnings: r.warnings.length,
      commit: r.commit ?? '',
      sha256: r.sha256,
      build: j ? `#${j.buildNumber}` : '',
      buildResult: j?.buildResult ?? '',
      quayTag: q?.tagName ?? '',
      imageMB: q?.tagSize ? (q.tagSize / 1024 / 1024).toFixed(2) : '',
      gitAuthor: g?.commitAuthor ?? '',
      gitDate: g?.commitDate ?? '',
      gitMessage: g?.commitMessage ?? '',
      detail: [...r.issues, ...r.warnings].join('; '),
    };
  });
}
