import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { emitDataReport, reportBase, writeDataReport } from './dataReport';

/**
 * The helper takes an explicit `outDir`, so these run against a throwaway temp dir
 * and never touch the configured output dir or RUBATO_HOME.
 */
describe('dataReport', () => {
  const tmp = () => mkdtempSync(resolve(tmpdir(), 'rubato-report-'));

  test('writes <base>.report.json (overview + rows) and .report.csv (tabular)', async () => {
    const outDir = tmp();
    const rows = [
      { app: 'a', changes: 2 },
      { app: 'b', changes: 0 },
    ];
    const { jsonPath, csvPath } = await writeDataReport(
      {
        overview: { command: 'findchanges', generatedAt: '2026-01-01T00:00:00.000Z', summary: { apps: 2 } },
        rows,
        columns: ['app', 'changes'],
      },
      { outDir },
    );

    expect(jsonPath).toBe(resolve(outDir, 'findchanges.report.json'));
    expect(csvPath).toBe(resolve(outDir, 'findchanges.report.csv'));

    const json = JSON.parse(await Bun.file(jsonPath).text());
    expect(json.overview.command).toBe('findchanges');
    expect(json.overview.summary.apps).toBe(2);
    expect(json.rows).toEqual(rows);

    const csv = await Bun.file(csvPath).text();
    expect(csv.split('\n')[0]).toBe('app,changes');
    expect(csv).toContain('a,2');
    expect(csv).toContain('b,0');
  });

  test('base defaults to the command name; an explicit base overrides it', async () => {
    const outDir = tmp();
    const a = await writeDataReport({ overview: { command: 'appstatus', generatedAt: 'x' }, rows: [] }, { outDir });
    expect(a.jsonPath).toBe(resolve(outDir, 'appstatus.report.json'));

    const b = await writeDataReport(
      { overview: { command: 'verifyshas', generatedAt: 'x' }, rows: [] },
      { outDir, base: 'custom' },
    );
    expect(b.jsonPath).toBe(resolve(outDir, 'custom.report.json'));
  });

  test('emitDataReport is best-effort: returns null and never throws on a bad dir', async () => {
    const lines: string[] = [];
    const paths = await emitDataReport(
      { overview: { command: 'x', generatedAt: 'x' }, rows: [] },
      { outDir: '/no/such/dir/that/exists', err: (l) => lines.push(l) },
    );
    expect(paths).toBeNull();
    expect(lines.some((l) => l.includes('could not write report'))).toBe(true);
  });

  test('emitDataReport prints a stderr note pointing at the json path', async () => {
    const outDir = tmp();
    const lines: string[] = [];
    const paths = await emitDataReport(
      { overview: { command: 'pull', generatedAt: 'x' }, rows: [{ app: 'a', state: 'updated' }] },
      { outDir, err: (l) => lines.push(l) },
    );
    expect(paths).not.toBeNull();
    expect(lines.some((l) => l.includes('pull.report.json'))).toBe(true);
  });

  test('reportBase sanitizes unsafe characters', () => {
    expect(reportBase('remote-branches')).toBe('remote-branches');
    expect(reportBase('a/b c')).toBe('a_b_c');
    expect(reportBase('')).toBe('report');
  });
});
