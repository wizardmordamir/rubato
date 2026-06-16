import { describe, expect, test } from 'bun:test';
import { extractAppScanReport } from './extractAppScanReport';

/** Build a minimal single-page PDF whose text layer is `text`. */
function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 14 Tf 72 700 Td (${text}) Tj ET`;
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(pdf.length);
    pdf += o;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe('extractAppScanReport', () => {
  test("extracts a real PDF's text and parses AppScan stats end-to-end", async () => {
    const pdf = makePdf('HCL AppScan Report SAST Critical 3 High 11 Medium 20 Low 6');
    const report = await extractAppScanReport(pdf);
    expect(report.isAppScan).toBe(true);
    expect(report.scanType).toBe('SAST');
    expect(report.severities).toEqual({ critical: 3, high: 11, medium: 20, low: 6, informational: 0 });
    expect(report.total).toBe(40);
    expect(report.issueTypes).toEqual([]);
    expect(report.text).toContain('AppScan');
  });
});
