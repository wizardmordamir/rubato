import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WalkedFile } from '../walkFiles';
import {
  hasNulByte,
  isLockfile,
  isPdfName,
  looksBinaryName,
  looksMinified,
  matchGlob,
  readPdfText,
  readTextFiles,
} from './textFiles';

/** Build a minimal single-page PDF whose text layer is `text`. */
function makePdf(text: string): Uint8Array {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length 80 >>\nstream\nBT /F1 14 Tf 72 700 Td (${text}) Tj ET\nendstream\nendobj\n`,
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

describe('file classification', () => {
  test('binary, minified, and lockfile names', () => {
    expect(looksBinaryName('logo.png')).toBe(true);
    expect(looksBinaryName('model.onnx')).toBe(true);
    expect(looksBinaryName('index.ts')).toBe(false);
    expect(looksBinaryName('report.pdf')).toBe(true); // binary by extension…
    expect(isPdfName('report.pdf')).toBe(true); // …but read specially
    expect(isPdfName('index.ts')).toBe(false);
    expect(looksMinified('app.min.js')).toBe(true);
    expect(looksMinified('bundle.js.map')).toBe(true);
    expect(isLockfile('bun.lock')).toBe(true);
    expect(isLockfile('index.ts')).toBe(false);
  });

  test('NUL-byte sniff distinguishes binary from text', () => {
    expect(hasNulByte(new Uint8Array([1, 2, 0, 3]))).toBe(true);
    expect(hasNulByte(new TextEncoder().encode('plain text'))).toBe(false);
  });
});

describe('matchGlob', () => {
  test('* does not cross slashes; ** does', () => {
    expect(matchGlob('src/index.ts', 'src/*.ts')).toBe(true);
    expect(matchGlob('src/a/b.ts', 'src/*.ts')).toBe(false);
    expect(matchGlob('src/a/b.ts', 'src/**')).toBe(true);
    expect(matchGlob('README.md', '*.md')).toBe(true);
  });
});

describe('readPdfText', () => {
  test("extracts a PDF's text layer", async () => {
    const text = await readPdfText(makePdf('Quarterly report contents here'));
    expect(text).toContain('Quarterly report contents here');
  });

  test('returns null for non-PDF / unparseable bytes (graceful skip)', async () => {
    expect(await readPdfText(new TextEncoder().encode('not a pdf at all'))).toBeNull();
  });
});

describe('readTextFiles', () => {
  test("reads source + a PDF's text, skips binaries and lockfiles", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-textfiles-'));
    try {
      await writeFile(join(dir, 'index.ts'), 'export const x = 1;');
      await writeFile(join(dir, 'report.pdf'), makePdf('AppScan SAST Critical 3'));
      await writeFile(join(dir, 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
      await writeFile(join(dir, 'bun.lock'), 'lockfile contents');

      const files: WalkedFile[] = ['index.ts', 'report.pdf', 'logo.png', 'bun.lock'].map((n) => ({
        fullPath: join(dir, n),
        relativePath: n,
      }));
      const out = await readTextFiles(files);
      const byPath = Object.fromEntries(out.map((t) => [t.relativePath, t.content]));

      expect(Object.keys(byPath).sort()).toEqual(['index.ts', 'report.pdf']);
      expect(byPath['index.ts']).toBe('export const x = 1;');
      expect(byPath['report.pdf']).toContain('AppScan SAST Critical 3');
      // The PDF row reports its on-disk byte length, not the extracted text length.
      const pdfRow = out.find((t) => t.relativePath === 'report.pdf');
      expect(pdfRow?.bytes).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('honors include/exclude globs for PDFs too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-textfiles-'));
    try {
      await writeFile(join(dir, 'keep.pdf'), makePdf('keep me'));
      await writeFile(join(dir, 'skip.pdf'), makePdf('skip me'));
      const files: WalkedFile[] = ['keep.pdf', 'skip.pdf'].map((n) => ({
        fullPath: join(dir, n),
        relativePath: n,
      }));
      const out = await readTextFiles(files, { exclude: ['skip.pdf'] });
      expect(out.map((t) => t.relativePath)).toEqual(['keep.pdf']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
