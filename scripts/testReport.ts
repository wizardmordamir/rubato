#!/usr/bin/env bun
/**
 * Run the test suite and write a structured run report the Test Reports page reads.
 * Mirrors the unit/functional gate but funnels results through cwip's report model:
 * spawn `bun test` with JUnit output, parse it (cwip parseJUnitXml), and write
 * `<id>.json/.html/.txt` into TEST_REPORTS_DIR (the REAL ~/.rubato, since the child
 * `bun test` isolates its own RUBATO_HOME). Pass extra `bun test` args after `--`.
 *
 *   bun run scripts/testReport.ts                 # whole suite
 *   bun run scripts/testReport.ts -- src/test/integration
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRunReport, parseJUnitXml, summarizeReport, writeReportFiles } from 'cwip/testing';
import { TEST_REPORTS_DIR } from '../src/lib/config';

const REPO_ROOT = resolve(import.meta.dir, '..');
const extraArgs = process.argv.slice(2).filter((a) => a !== '--');
const junitFile = join(mkdtempSync(join(tmpdir(), 'rubato-junit-')), 'junit.xml');

const startedAt = new Date().toISOString();
const res = spawnSync('bun', ['test', '--reporter=junit', `--reporter-outfile=${junitFile}`, ...extraArgs], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

let xml = '';
try {
  xml = readFileSync(junitFile, 'utf8');
} catch {
  // suite may have crashed before writing JUnit
}
rmSync(junitFile, { force: true });

const rec = createRunReport('unit', { startedAt, meta: { mode: 'bun test', exitCode: res.status ?? null } });
for (const c of parseJUnitXml(xml).cases) rec.record(c);
const report = rec.finish();
const written = writeReportFiles(TEST_REPORTS_DIR, report);
console.log(`[test:report] ${summarizeReport(report)} → ${written.json}`);
process.exit(res.status ?? 1);
