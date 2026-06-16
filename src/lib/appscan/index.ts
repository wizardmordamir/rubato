/**
 * `rubato/appscan` — parse HCL AppScan / "AppScan on Cloud" (ASoC) security
 * report PDFs into structured vulnerability stats (severity counts, scan type,
 * application), for rolling up into dashboards.
 *
 *   import { parseAppScanPdf } from "rubato/appscan";
 *   const { severities, scanType, application } = await parseAppScanPdf("report.pdf");
 *
 * `parseAppScanReport` is pure (text → stats); `extractAppScanReport`/
 * `parseAppScanPdf` add the PDF read (cwip's lazy `extractPdfText`, needs the
 * optional `unpdf` dep).
 */

export * from './extractAppScanReport';
export * from './parseAppScanReport';
