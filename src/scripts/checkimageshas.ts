#!/usr/bin/env bun
/**
 * checkimageshas  (installed as a shell function)
 *
 * Quick image-existence check: for each `app version sha256:<digest>` line in a
 * list, confirm the digest is actually a tag in the app's Quay repo. Lighter than
 * `verifyshas` (no commit/build correlation) — answers "is this image really
 * published?". Exits non-zero if any digest is MISSING.
 *
 * Usage (after rubato-setup):
 *   checkimageshas [listFile] [--json | --csv]
 */

import { loadApps } from '../lib/apps';
import { emitDataReport } from '../lib/dataReport';
import { checkImageList } from '../lib/deploy/checkImages';
import { buildDeployClients } from '../lib/deploy/clients';
import { parseImageShaList } from '../lib/deploy/parseList';
import { type Row, toCsv, toTable } from '../lib/output';

const COLUMNS = ['app', 'version', 'sha256', 'status', 'tag', 'note'];

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const asCsv = args.includes('--csv');
  const listFile = args.find((a) => !a.startsWith('--')) ?? './imageShasList.txt';

  const file = Bun.file(listFile);
  if (!(await file.exists())) {
    console.error(`checkimageshas: list file not found: ${listFile}`);
    process.exit(1);
  }

  const { entries, problems } = parseImageShaList(await file.text());
  for (const p of problems) console.error(`  ! line ${p.line}: ${p.message}`);
  if (entries.length === 0) {
    console.error(`checkimageshas: no digests parsed from ${listFile}`);
    process.exit(1);
  }

  const apps = await loadApps();
  const clients = await buildDeployClients(apps, { quay: true });
  const results = await checkImageList(entries, apps, clients.quay ?? null);

  const rows: Row[] = results.map((r) => ({
    app: r.app ?? '',
    version: r.version ?? '',
    sha256: `${r.sha256.slice(0, 12)}…`,
    status: r.status,
    tag: r.tag ?? '',
    note: r.note ?? '',
  }));

  const found = results.filter((r) => r.status === 'FOUND').length;
  const missing = results.filter((r) => r.status === 'MISSING').length;
  const skipped = results.filter((r) => r.status === 'SKIPPED').length;

  await emitDataReport({
    overview: {
      command: 'checkimageshas',
      generatedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      args,
      summary: { listPath: listFile, entries: results.length, found, missing, skipped },
    },
    rows,
    columns: COLUMNS,
  });

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else if (asCsv) {
    console.log(toCsv(rows, COLUMNS));
  } else {
    console.log(toTable(rows, COLUMNS));
    console.log(`\n${found} found, ${missing} missing, ${skipped} skipped.`);
  }

  if (missing > 0) process.exit(2);
}

if (import.meta.main) await main();
