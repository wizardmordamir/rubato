/**
 * Test Reports API. The test runner writes structured run reports (cwip
 * `writeReportFiles`) into TEST_REPORTS_DIR — `<id>.json` plus a `<id>-artifacts/`
 * dir of debug artifacts. These read-only endpoints list runs, serve one run's
 * full detail, and stream an artifact for the Test Reports page (shared
 * `cwip/react` <TestReportViewer>). The dir reader + traversal-safe path resolver
 * are the shared `cwip/test-report` primitives.
 */

import { readReport, readReportSummaries, resolveArtifactPath } from 'cwip/test-report';
import { TEST_REPORTS_DIR } from '../lib/config';
import { json, jsonError } from './http';

const ARTIFACT_RE = /^\/api\/test-reports\/([^/]+)\/artifacts\/([^/]+)$/;
const DETAIL_RE = /^\/api\/test-reports\/([^/]+)$/;

export function handleTestReportsApi(pathname: string, req: Request): Response {
  if (req.method !== 'GET') return jsonError('use GET', 405);

  if (pathname === '/api/test-reports') {
    return json({ reports: readReportSummaries(TEST_REPORTS_DIR) });
  }

  const art = pathname.match(ARTIFACT_RE);
  if (art) {
    const file = resolveArtifactPath(TEST_REPORTS_DIR, decodeURIComponent(art[1]), decodeURIComponent(art[2]));
    if (!file) return jsonError('artifact not found', 404);
    return new Response(Bun.file(file));
  }

  const detail = pathname.match(DETAIL_RE);
  if (detail) {
    const report = readReport(TEST_REPORTS_DIR, decodeURIComponent(detail[1]));
    if (!report) return jsonError('report not found', 404);
    return json({ report });
  }

  return jsonError(`not found: ${pathname}`, 404);
}
