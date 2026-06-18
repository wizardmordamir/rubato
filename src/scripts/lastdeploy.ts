#!/usr/bin/env bun
/**
 * lastdeploy  (installed as a shell function)
 *
 * Single app:  show the latest *successful* build for an app/env, with the branch
 * and commit it built from — "what's currently deployed and from which commit".
 *
 * All apps (--all):  a portfolio view — for every app with Jenkins config, the
 * most recent build and the last successful build (number + commit) side by side.
 *
 * Usage (after rubato-setup):
 *   lastdeploy <app> [env]
 *   lastdeploy --all [app|group] [--env <env>] [--json | --csv]
 */

import {
  buildStatus,
  fmtDuration,
  getBuildBranch,
  getBuildCommits,
  type JenkinsAppApi,
  resolveAppJenkins,
} from '../api/jenkins';
import { selectApps } from '../lib/appSelect';
import { getAppApi, loadApps } from '../lib/apps';
import { emitDataReport } from '../lib/dataReport';
import { buildDeployClients } from '../lib/deploy/clients';
import { type Row, toCsv, toTable } from '../lib/output';

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

const ALL_COLUMNS = ['app', 'recent', 'recentStatus', 'recentWhen', 'lastSuccess', 'successCommit'];

async function allMode(args: string[]): Promise<void> {
  const startedAt = Date.now();
  const env = getOpt(args, 'env');
  const asJson = args.includes('--json');
  const asCsv = args.includes('--csv');
  const filter = args.find((a) => !a.startsWith('--') && a !== env && a !== '--all');

  const apps = selectApps(await loadApps(), { filter }).filter((a) => getAppApi(a, 'jenkins'));
  if (apps.length === 0) {
    console.error(`lastdeploy --all: no apps with Jenkins config${filter ? ` matching "${filter}"` : ''}.`);
    process.exit(1);
  }

  const clients = await buildDeployClients(apps, { jenkins: true, quay: false });
  if (!clients.jenkins) {
    console.error('lastdeploy --all: Jenkins not configured. Run rubato-init.');
    process.exit(1);
  }
  const jenkins = clients.jenkins;

  const rows: Row[] = await Promise.all(
    apps.map(async (app) => {
      const api = getAppApi(app, 'jenkins') as JenkinsAppApi;
      const row: Row = { app: app.name };
      try {
        const [recent, success] = await Promise.all([
          jenkins.getLatestBuildForApp(api, { env }),
          jenkins.getLatestBuildForApp(api, { env, filter: { status: 'success' } }),
        ]);
        if (recent) {
          row.recent = `#${recent.number}`;
          row.recentStatus = buildStatus(recent);
          row.recentWhen = new Date(recent.timestamp).toISOString();
        }
        if (success) {
          row.lastSuccess = `#${success.number}`;
          row.successCommit = getBuildCommits(success)[0]?.slice(0, 8) ?? '';
        }
      } catch {
        row.recentStatus = 'err';
      }
      return row;
    }),
  );

  await emitDataReport({
    overview: {
      command: 'lastdeploy',
      generatedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      args,
      summary: { apps: rows.length, env: env ?? '(default)' },
    },
    rows,
    columns: ALL_COLUMNS,
  });

  if (asJson) console.log(JSON.stringify(rows, null, 2));
  else if (asCsv) console.log(toCsv(rows, ALL_COLUMNS));
  else console.log(toTable(rows, ALL_COLUMNS));
}

async function singleMode(query: string, env: string | undefined): Promise<void> {
  const { app, jenkins, client } = await resolveAppJenkins(query);
  const build = await client.getLatestBuildForApp(jenkins, { env, filter: { status: 'success' } });

  if (!build) {
    console.error(`No successful build for ${app.name}${env ? ` (env ${env})` : ''}.`);
    process.exit(1);
  }

  const commits = getBuildCommits(build);
  console.log(`Last successful deploy for ${env ? `${app.name} [${env}]` : app.name}:`);
  console.log(`  Build:    #${build.number}`);
  console.log(`  When:     ${new Date(build.timestamp).toISOString()}`);
  console.log(`  Duration: ${fmtDuration(build.duration)}`);
  console.log(`  Branch:   ${getBuildBranch(build) ?? '—'}`);
  console.log(`  Commit:   ${commits[0] ?? '—'}${commits.length > 1 ? ` (+${commits.length - 1} more)` : ''}`);
  console.log(`  URL:      ${build.url}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--all')) {
    await allMode(args);
    return;
  }
  const [query, env] = args.filter((a) => !a.startsWith('--'));
  if (!query) {
    console.error('usage: lastdeploy <app> [env]   |   lastdeploy --all [app|group] [--env <env>] [--json|--csv]');
    process.exit(1);
  }
  await singleMode(query, env);
}

if (import.meta.main)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
