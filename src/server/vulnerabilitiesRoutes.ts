/**
 * Vulnerabilities API: per-app security-scan stats (from AppScan/ASoC reports)
 * for the Vulnerabilities view.
 *
 *   GET    /api/vulnerabilities               → { records, stats }
 *   POST   /api/vulnerabilities               → upsert one record (manual entry / scaffolding)
 *   POST   /api/vulnerabilities/import-pdf     → parse an uploaded AppScan PDF + upsert (multipart "file")
 *   GET    /api/vulnerabilities/:app/report    → the stored report PDF, served inline (?scanType=)
 *   POST   /api/vulnerabilities/:app/plan       → generate an AI remediation plan from the record (?scanType=)
 *   DELETE /api/vulnerabilities                → clear all (+ stored report PDFs)
 *   DELETE /api/vulnerabilities/:app           → delete one app's record (?scanType= optional)
 *
 * Records are normally written by the `appscan-pdf` pipeline script or imported
 * here from a PDF; POST also lets you populate the view by hand. Uploaded report
 * PDFs are kept under ~/.rubato/uploads/vuln-reports/<id>.pdf and served inline so
 * the report is openable in the UI / a browser PDF viewer.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { completeText } from '../api/llm/complete';
import { llmFromConfig } from '../api/llm/fromConfig';
import { loadApps } from '../lib/apps';
import { extractAppScanReport } from '../lib/appscan';
import { RUBATO_HOME } from '../lib/config';
import { deployApps } from '../lib/deployApps';
import { defaultPlanTitle, generatePlan, type PlanInput } from '../lib/remediationPlan';
import { computeVulnStats } from '../lib/vulnStats';
import type { VulnerabilitiesResponse, VulnerabilityInput } from '../shared/vulnerabilities';
import {
  clearVulnerabilities,
  deleteVulnerability,
  getVulnerabilityReportName,
  listVulnerabilities,
  savePlan,
  setVulnerabilityLink,
  upsertVulnerability,
} from './db';
import { json, jsonError, readJsonBody } from './http';

const REPORTS_DIR = resolve(RUBATO_HOME, 'uploads', 'vuln-reports');
const MAX_PDF_BYTES = 25 * 1024 * 1024;
/** Only names this server generated: uuid + ".pdf". Guards the serve route from traversal. */
const SAFE_REPORT_NAME = /^[0-9a-f-]{36}\.pdf$/;

function snapshot(): VulnerabilitiesResponse {
  const records = listVulnerabilities();
  return { records, stats: computeVulnStats(records) };
}

/** Best-effort unlink of a stored report PDF (ignore if already gone). */
async function removeReport(name: string | null | undefined): Promise<void> {
  if (!name || !SAFE_REPORT_NAME.test(name)) return;
  await unlink(resolve(REPORTS_DIR, name)).catch(() => {});
}

/** Parse an uploaded AppScan PDF, store the bytes, and upsert the record. */
async function importPdf(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("multipart form data with a 'file' field required", 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return jsonError("'file' field (a PDF) required", 400);
  if (file.size > MAX_PDF_BYTES) return jsonError('report too large (25MB max)', 413);
  const looksPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
  if (!looksPdf) return jsonError(`expected a .pdf file (got ${file.type || file.name || 'unknown'})`, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  let report: Awaited<ReturnType<typeof extractAppScanReport>>;
  try {
    report = await extractAppScanReport(bytes);
  } catch (err) {
    return jsonError(`could not read the PDF: ${err instanceof Error ? err.message : String(err)}`, 422);
  }

  const appField = String(form.get('app') ?? '').trim();
  const scanField = String(form.get('scanType') ?? '').trim();
  const app = appField || report.application || file.name.replace(/\.pdf$/i, '') || 'unnamed';
  const scanType = scanField || report.scanType || '';
  const linkedApp = String(form.get('linkedApp') ?? '').trim() || undefined;
  const store = form.get('store') !== 'false';

  // Persist the PDF so it can be re-opened in the UI / a browser PDF viewer.
  let reportName: string | undefined;
  if (store) {
    const prev = getVulnerabilityReportName(app, scanType);
    mkdirSync(REPORTS_DIR, { recursive: true });
    reportName = `${randomUUID()}.pdf`;
    await Bun.write(resolve(REPORTS_DIR, reportName), bytes);
    await removeReport(prev); // drop the superseded PDF for this (app, scanType)
  }

  const { text: _text, ...stats } = report;
  if (store) {
    upsertVulnerability({
      app,
      scanType,
      critical: report.severities.critical,
      high: report.severities.high,
      medium: report.severities.medium,
      low: report.severities.low,
      informational: report.severities.informational,
      issueTypes: report.issueTypes,
      sourceFile: file.name,
      reportName,
      linkedApp,
      raw: stats,
    });
  }

  return json({ ...snapshot(), imported: { app, scanType, isAppScan: report.isAppScan, report: stats } });
}

/** Serve a stored report PDF inline (so a browser renders it in its viewer). */
function serveReport(app: string, scanType: string): Response {
  const name = getVulnerabilityReportName(app, scanType);
  if (!name || !SAFE_REPORT_NAME.test(name)) return jsonError('no stored report for that app/scan', 404);
  const file = Bun.file(resolve(REPORTS_DIR, name));
  const safeFilename = `${app.replace(/[^A-Za-z0-9._-]/g, '_')}${scanType ? `-${scanType}` : ''}.pdf`;
  return new Response(file, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${safeFilename}"`,
    },
  });
}

/** Generate an AI remediation plan from a stored record and save it to the Plans table. */
async function generateRecordPlan(app: string, scanType: string): Promise<Response> {
  const record = listVulnerabilities().find((r) => r.app === app && r.scanType === scanType);
  if (!record) return jsonError('no record for that app/scanType', 404);

  const input: PlanInput = {
    app,
    data: {
      app,
      scanType: record.scanType,
      severities: {
        critical: record.critical,
        high: record.high,
        medium: record.medium,
        low: record.low,
        informational: record.informational,
      },
      total: record.total,
      issueTypes: record.issueTypes ?? [],
    },
  };

  let md: string;
  try {
    const provider = await llmFromConfig();
    md = await generatePlan((messages) => completeText(provider, messages), input);
  } catch (err) {
    // Env-gated: no LLM configured (or the model errored) → a clear 412, not a 500.
    return jsonError(err instanceof Error ? err.message : 'remediation plan generation failed', 412);
  }

  const title = defaultPlanTitle({ ...input, title: `Remediation plan — ${app}${scanType ? ` (${scanType})` : ''}` });
  const plan = savePlan({ title, app, source: 'vulnerabilities', content: md });
  return json({ planId: plan.id, title: plan.title });
}

/**
 * Associate a scan with a registered app (the deployed app its findings belong to),
 * or clear the association with `null`/empty. A non-empty name must be a real
 * registry app (else 400); the stored value is the canonical registry name.
 */
async function setRecordLink(app: string, scanType: string, req: Request): Promise<Response> {
  const body = await readJsonBody<{ linkedApp?: string | null }>(req);
  const wanted = typeof body?.linkedApp === 'string' ? body.linkedApp.trim() : '';
  let linkedApp: string | null = null;
  if (wanted) {
    const match = (await loadApps()).find((a) => a.name === wanted);
    if (!match) return jsonError(`unknown app "${wanted}"`, 400);
    linkedApp = match.name;
  }
  const record = setVulnerabilityLink(app, scanType, linkedApp);
  if (!record) return jsonError('no record for that app/scanType', 404);
  return json({ ...snapshot(), record });
}

export async function handleVulnerabilitiesApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/vulnerabilities') {
    if (req.method === 'GET') return json(snapshot());

    if (req.method === 'POST') {
      const body = await readJsonBody<VulnerabilityInput>(req);
      if (!body?.app?.trim()) return jsonError('app is required', 400);
      upsertVulnerability({ ...body, app: body.app.trim() });
      return json(snapshot());
    }

    if (req.method === 'DELETE') {
      // Drop every stored report PDF along with the rows.
      await Promise.all(listVulnerabilities().map((r) => removeReport(r.reportName)));
      clearVulnerabilities();
      return json(snapshot());
    }
    return jsonError('use GET, POST, or DELETE', 405);
  }

  // POST /api/vulnerabilities/import-pdf
  if (pathname === '/api/vulnerabilities/import-pdf') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    return importPdf(req);
  }

  // GET /api/vulnerabilities/deploy-apps — registry apps that deploy via Jenkins/
  // Harness (the candidates an imported scan can be associated with).
  if (pathname === '/api/vulnerabilities/deploy-apps') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return json(deployApps(await loadApps()));
  }

  // GET /api/vulnerabilities/:app/report  (?scanType=)
  const reportMatch = pathname.match(/^\/api\/vulnerabilities\/([^/]+)\/report$/);
  if (reportMatch) {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    const app = decodeURIComponent(reportMatch[1]);
    const scanType = new URL(req.url).searchParams.get('scanType') ?? '';
    return serveReport(app, scanType);
  }

  // POST /api/vulnerabilities/:app/plan  (?scanType=)
  const planMatch = pathname.match(/^\/api\/vulnerabilities\/([^/]+)\/plan$/);
  if (planMatch) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const app = decodeURIComponent(planMatch[1]);
    const scanType = new URL(req.url).searchParams.get('scanType') ?? '';
    return generateRecordPlan(app, scanType);
  }

  // POST /api/vulnerabilities/:app/link  (?scanType=) — associate the scan with a
  // deployed app (body { linkedApp }), or clear it (linkedApp: null/"").
  const linkMatch = pathname.match(/^\/api\/vulnerabilities\/([^/]+)\/link$/);
  if (linkMatch) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const app = decodeURIComponent(linkMatch[1]);
    const scanType = new URL(req.url).searchParams.get('scanType') ?? '';
    return setRecordLink(app, scanType, req);
  }

  // DELETE /api/vulnerabilities/:app  (?scanType=)
  const m = pathname.match(/^\/api\/vulnerabilities\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    const app = decodeURIComponent(m[1]);
    const scanType = new URL(req.url).searchParams.get('scanType') ?? '';
    await removeReport(getVulnerabilityReportName(app, scanType));
    const removed = deleteVulnerability(app, scanType);
    if (!removed) return jsonError('no record for that app/scanType', 404);
    return json(snapshot());
  }

  return jsonError(`not found: ${pathname}`, 404);
}
