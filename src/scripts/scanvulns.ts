#!/usr/bin/env bun
/**
 * scanvulns  (installed as a shell function)
 *
 * Summarize the container security scan for one app (or a group): pull the Quay
 * image's Clair scan and tally vulnerabilities by severity. Complements `scans`,
 * which downloads Jenkins scan *artifacts* — this reads the registry's own scan.
 *
 * Usage (after rubato-setup):
 *   scanvulns [app|group] [--version <tag>] [--json | --csv]
 */

import type { QuayAppApi } from '../lib/appApis';
import { selectApps } from '../lib/appSelect';
import { getAppApi, loadApps } from '../lib/apps';
import { emitDataReport } from '../lib/dataReport';
import { buildDeployClients } from '../lib/deploy/clients';
import { SEVERITIES, summarizeVulnerabilities } from '../lib/deploy/scanVulns';
import { type Row, toCsv, toTable } from '../lib/output';

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

const COLUMNS = ['app', 'tag', 'status', ...SEVERITIES, 'total'];

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const version = getOpt(args, 'version');
  const asJson = args.includes('--json');
  const asCsv = args.includes('--csv');
  const filter = args.find((a) => !a.startsWith('--') && a !== version);

  const apps = selectApps(await loadApps(), { filter }).filter((a) => getAppApi(a, 'quay'));
  if (apps.length === 0) {
    console.error(`scanvulns: no apps with Quay config${filter ? ` matching "${filter}"` : ''}.`);
    process.exit(1);
  }

  const clients = await buildDeployClients(apps, { quay: true });
  if (!clients.quay) {
    console.error('scanvulns: Quay not configured. Run rubato-init.');
    process.exit(1);
  }
  const quay = clients.quay;

  const rows: Row[] = await Promise.all(
    apps.map(async (app) => {
      const repo = (getAppApi(app, 'quay') as QuayAppApi).repository;
      const row: Row = { app: app.name };
      try {
        const tag = version
          ? (await quay.getTags(repo, { tag: version, onlyActive: false })).find((t) => t.name === version)
          : await quay.getLatestTag(repo);
        if (!tag?.manifest_digest) {
          row.status = 'no-image';
          return row;
        }
        row.tag = tag.name;
        const summary = summarizeVulnerabilities(await quay.getSecurity(repo, tag.manifest_digest));
        row.status = summary.status;
        for (const s of SEVERITIES) row[s] = summary.counts[s];
        row.total = summary.total;
      } catch (err) {
        row.status = `err: ${(err as Error).message}`;
      }
      return row;
    }),
  );

  const totals = Object.fromEntries(
    SEVERITIES.map((s) => [s, rows.reduce((n, r) => n + (typeof r[s] === 'number' ? (r[s] as number) : 0), 0)]),
  );
  await emitDataReport({
    overview: {
      command: 'scanvulns',
      generatedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      args,
      summary: { apps: rows.length, version: version ?? 'latest', totalsBySeverity: totals },
    },
    rows,
    columns: COLUMNS,
  });

  if (asJson) console.log(JSON.stringify(rows, null, 2));
  else if (asCsv) console.log(toCsv(rows, COLUMNS));
  else console.log(toTable(rows, COLUMNS));
}

if (import.meta.main) await main();
