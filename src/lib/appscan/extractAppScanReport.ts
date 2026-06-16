/**
 * Impure seam: read a PDF's text (via cwip's lazy `extractPdfText`) and parse it
 * into AppScan stats. Kept apart from the pure `parseAppScanReport` so the parser
 * stays dependency-free and testable, while this one wires in the PDF backend.
 */

import { readFile } from 'node:fs/promises';
import { extractPdfText } from 'cwip/node';
import { type AppScanReport, parseAppScanReport } from './parseAppScanReport';

/** Parse the structured stats out of AppScan report PDF bytes (incl. the raw text). */
export async function extractAppScanReport(data: Uint8Array | ArrayBuffer): Promise<AppScanReport & { text: string }> {
  const { text } = await extractPdfText(data);
  return { ...parseAppScanReport(text), text };
}

/** Read an AppScan report PDF from disk and parse its stats. */
export async function parseAppScanPdf(path: string): Promise<AppScanReport & { text: string }> {
  return extractAppScanReport(await readFile(path));
}
