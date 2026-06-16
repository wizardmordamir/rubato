#!/usr/bin/env bun
/**
 * appall  (installed as a shell function)
 *
 * Cross-app status dashboard: for every configured app (or a group/single app),
 * gather the joined view from whatever APIs it has — latest Jenkins build
 * (number, status, branch, commit) and latest Quay image tag. Resilient: a
 * service that isn't configured, or a per-app error, just leaves blanks rather
 * than failing the run.
 *
 * Usage (after rubato-setup):
 *   appall [app|group] [--env <env>] [--json | --csv]
 */

import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import { emitDataReport } from '../lib/dataReport';
import { buildDeployClients } from '../lib/deploy/clients';
import { type CollectedRecord, collectApps } from '../lib/deploy/collect';
import { type Row, toCsv, toTable } from '../lib/output';

const COLUMNS = ['name', 'group', 'build', 'status', 'branch', 'commit', 'image'];

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

function toRow(r: CollectedRecord): Row {
  const jenkinsErr = r.errors.some((e) => e.startsWith('jenkins:'));
  const quayErr = r.errors.some((e) => e.startsWith('quay:'));
  return {
    name: r.app.name,
    group: r.app.group ?? '',
    build: r.jenkins ? `#${r.jenkins.number}` : '',
    status: r.jenkins?.status ?? (jenkinsErr ? 'err' : ''),
    branch: r.jenkins?.branch ?? '',
    commit: r.jenkins?.commit?.slice(0, 8) ?? '',
    image: r.quay?.version ?? (quayErr ? 'err' : ''),
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const env = getOpt(args, 'env');
  const asJson = args.includes('--json');
  const asCsv = args.includes('--csv');
  const rich = args.includes('--rich');
  const filter = args.find((a) => !a.startsWith('--') && a !== env);

  const apps = selectApps(await loadApps(), { filter }).filter((a) => a.apis?.length);
  if (apps.length === 0) {
    console.error(`appall: no apps with api config${filter ? ` matching "${filter}"` : ''}. Edit ~/.rubato/apps.json.`);
    process.exit(1);
  }

  const clients = await buildDeployClients(apps);
  const records = await collectApps(apps, clients, { env });

  const rows = records.map(toRow);
  await emitDataReport({
    overview: {
      command: 'appall',
      generatedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      args,
      summary: {
        apps: rows.length,
        env: env ?? '(default)',
        withErrors: records.filter((r) => r.errors.length).length,
      },
    },
    rows,
    columns: COLUMNS,
  });

  if (asJson) {
    // --rich keeps the full joined record (build, quay tag digest/size, errors);
    // plain --json stays the flat table shape for back-compat.
    console.log(JSON.stringify(rich ? records.map(richJson) : records.map(toRow), null, 2));
  } else if (asCsv) {
    console.log(toCsv(records.map(toRow), COLUMNS));
  } else {
    console.log(toTable(records.map(toRow), COLUMNS));
    if (!clients.jenkins && apps.some((a) => a.apis?.some((api) => api.name === 'jenkins'))) {
      console.error('\n(Jenkins not configured — build columns blank. Run rubato-init.)');
    }
  }
}

/** The rich per-app object for `--rich --json`: the joined detail, minus the heavy raw build. */
function richJson(r: CollectedRecord) {
  return {
    name: r.app.name,
    group: r.app.group ?? null,
    label: r.label,
    jenkins: r.jenkins
      ? {
          number: r.jenkins.number,
          status: r.jenkins.status,
          branch: r.jenkins.branch,
          commit: r.jenkins.commit,
          url: r.jenkins.build.url,
          timestamp: r.jenkins.build.timestamp,
        }
      : null,
    quay: r.quay
      ? {
          version: r.quay.version,
          sha256: r.quay.sha256,
          manifestDigest: r.quay.tag.manifest_digest ?? null,
          size: r.quay.tag.size ?? null,
          lastModified: r.quay.tag.last_modified ?? null,
        }
      : null,
    errors: r.errors,
  };
}

if (import.meta.main) await main();
