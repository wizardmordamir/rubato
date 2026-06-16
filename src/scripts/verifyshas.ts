#!/usr/bin/env bun
/**
 * verifyshas  (installed as a shell function)
 *
 * Verify a hand-maintained deploy list against the live systems that are the
 * real source of truth. For each `app / version / commit / sha256` entry it
 * checks the dangerous things — the Quay image tag exists and its digest matches
 * the listed sha256, and the git commit exists — and enriches with the Jenkins
 * build. An entry FAILs on any of those hard mismatches; softer concerns (couldn't
 * pin the build, etc.) are warnings. Exits non-zero if anything FAILs, so it can
 * gate a deploy.
 *
 * The `verifyshas.report.json` + `.csv` reports are always written: to `--out <dir>`
 * if given, else the configured output dir (so the web UI "Files" tab shows them).
 *
 * Usage (after rubato-setup):
 *   verifyshas [listFile] [--env <env>] [--json | --csv] [--out <dir>]
 *
 * Logic lives in `run(args, io)` (returns an exit code, prints via `io`) so it's
 * unit-testable in-process — see scriptIo.ts.
 */

import { resolve } from 'node:path';
import { loadApps } from '../lib/apps';
import { writeDataReport } from '../lib/dataReport';
import { buildDeployClients } from '../lib/deploy/clients';
import { VERIFY_COLUMNS, verifyReportToRows } from '../lib/deploy/format';
import { parseDeployList } from '../lib/deploy/parseList';
import { verifyDeployList } from '../lib/deploy/verify';
import { startDiagnostics } from '../lib/diagnostics';
import { toCsv, toTable } from '../lib/output';
import { consoleIo, type ScriptIo } from '../lib/scriptIo';
import { recordVerification } from '../server/db';

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

export async function run(args: string[], io: ScriptIo = consoleIo): Promise<number> {
  const env = getOpt(args, 'env');
  const out = getOpt(args, 'out');
  const asJson = args.includes('--json');
  const asCsv = args.includes('--csv');
  const listFile = args.find((a) => !a.startsWith('--') && a !== env && a !== out) ?? './shasList.txt';

  const startedAt = Date.now();
  const diag = startDiagnostics({
    activity: 'verifyshas',
    intent: `verify deploy list ${listFile}`,
    console: false,
  });

  const file = Bun.file(listFile);
  if (!(await file.exists())) {
    io.err(`verifyshas: list file not found: ${listFile}`);
    diag.error(`list file not found: ${listFile}`);
    await diag.finish('error');
    return 1;
  }

  const { entries, problems } = parseDeployList(await file.text());
  for (const p of problems) io.err(`  ! line ${p.line}: ${p.message}`);
  diag.step('parsed deploy list', { listFile, entries: entries.length, problems: problems.length });
  if (entries.length === 0) {
    io.err(`verifyshas: no entries parsed from ${listFile}`);
    diag.error(`no entries parsed from ${listFile}`, { problems });
    await diag.finish('error');
    return 1;
  }

  const apps = await loadApps();
  const clients = await buildDeployClients(apps, { jenkins: true, quay: true, gitlab: true });
  diag.step('built deploy clients', { env: env ?? '(default)' });
  const report = await verifyDeployList(entries, apps, clients, { env });
  report.summary.listPath = listFile;
  diag.info('verified entries', report.summary);
  if (report.summary.failed > 0) {
    diag.warn('entries FAILed verification', {
      failed: report.results.filter((r) => r.status === 'FAIL').map((r) => `${r.app} ${r.version}`),
    });
  }

  // Best-effort history; never let a DB hiccup fail the verification.
  try {
    const verifiedAt = Date.now();
    for (const r of report.results) {
      recordVerification({
        verifiedAt,
        listPath: listFile,
        app: r.app,
        version: r.version,
        commitSha: r.commit,
        imageSha: r.sha256,
        status: r.status,
        issues: r.issues,
        warnings: r.warnings,
        metadata: r.metadata,
      });
    }
  } catch {
    // ignore — the report below is the source of truth
  }

  // Always write the structured report — to --out if given, else the output dir
  // (so it shows up in the web UI "Files"/"Reports" tab, not just a one-off --out
  // path). Uses the shared writer so the shape/naming match every other report;
  // the overview header makes the JSON self-describing + correlatable to the log.
  const { jsonPath, csvPath } = await writeDataReport(
    {
      overview: {
        command: 'verifyshas',
        generatedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        args,
        correlationId: diag.correlationId,
        summary: { env: env ?? '(default)', listPath: listFile, ...report.summary },
      },
      rows: verifyReportToRows(report),
      columns: VERIFY_COLUMNS,
    },
    { outDir: out ? resolve(out) : undefined },
  );
  io.err(`Wrote ${jsonPath} and ${csvPath}`);
  diag.step('wrote reports', { json: jsonPath, csv: csvPath });

  if (asJson) {
    io.out(JSON.stringify(report, null, 2));
  } else if (asCsv) {
    io.out(toCsv(verifyReportToRows(report), VERIFY_COLUMNS));
  } else {
    printHuman(report, io);
  }

  await diag.finish(report.summary.failed > 0 ? 'error' : 'ok');
  // Non-zero exit when any entry fails, so a deploy script can gate on it.
  return report.summary.failed > 0 ? 2 : 0;
}

function printHuman(report: Awaited<ReturnType<typeof verifyDeployList>>, io: ScriptIo): void {
  const cols = ['app', 'version', 'status', 'issues', 'warnings', 'build', 'quayTag'];
  io.out(toTable(verifyReportToRows(report), cols));
  const { passed, failed, totalEntries, totalWarnings } = report.summary;
  io.out(`\n${passed}/${totalEntries} passed, ${failed} failed, ${totalWarnings} warning(s).`);

  for (const r of report.results) {
    if (r.issues.length === 0 && r.warnings.length === 0) continue;
    io.out(`\n${r.status === 'FAIL' ? '✗' : '•'} ${r.app} ${r.version}`);
    for (const i of r.issues) io.out(`    issue:   ${i}`);
    for (const w of r.warnings) io.out(`    warning: ${w}`);
  }
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
