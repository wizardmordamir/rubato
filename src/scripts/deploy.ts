#!/usr/bin/env bun
/**
 * deploy  (installed as a shell function)
 *
 * Trigger a Jenkins deploy for an app — or every app under a group — to an
 * environment. Job paths (multibranch or not, per-env overrides) resolve from
 * each app's config.
 *
 * Safety: only apps with a jenkins config are targeted; apps that opt out via
 * ignoreCommandTypes: ["deploy"] are skipped; it confirms before triggering
 * (skip with --yes); --dry-run resolves + prints without triggering.
 *
 * Usage (after rubato-setup):
 *   deploy <app|group> <env> [branch] [KEY=VALUE ...] [--dry-run] [--yes]
 */

import { type JenkinsAppApi, jenkinsFromConfig } from '../api/jenkins';
import { selectApps } from '../lib/appSelect';
import { getAppApi, loadApps } from '../lib/apps';

function parseParams(tokens: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq === -1) {
      console.error(`deploy: ignoring "${token}" (expected KEY=VALUE)`);
      continue;
    }
    params[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return params;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const [filter, env, ...rest] = positional;

  if (!filter || !env) {
    console.error('usage: deploy <app|group> <env> [branch] [KEY=VALUE ...] [--dry-run] [--yes]');
    process.exit(1);
  }

  // The first remaining bare token is the branch; KEY=VALUE tokens are params.
  let branch: string | undefined;
  const paramTokens: string[] = [];
  for (const token of rest) {
    if (!branch && !token.includes('=')) branch = token;
    else paramTokens.push(token);
  }
  const params = parseParams(paramTokens);

  // Apps matching the filter (group or single app) that can be deployed.
  const targets = selectApps(await loadApps(), { filter, command: 'deploy' })
    .map((app) => ({ app, jenkins: getAppApi(app, 'jenkins') as JenkinsAppApi | undefined }))
    .filter((t): t is { app: (typeof t)['app']; jenkins: JenkinsAppApi } => Boolean(t.jenkins));

  if (targets.length === 0) {
    console.error(`deploy: no deployable app matches "${filter}" (needs a jenkins config; not ignoring "deploy").`);
    process.exit(1);
  }

  const client = await jenkinsFromConfig();

  // Resolve each job path now so config errors surface before triggering.
  const plan: Array<{ name: string; jenkins: JenkinsAppApi; jobPath: string }> = [];
  for (const t of targets) {
    try {
      plan.push({ name: t.app.name, jenkins: t.jenkins, jobPath: client.resolveJobPath(t.jenkins, { env, branch }) });
    } catch (err) {
      console.error(`  skip ${t.app.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (plan.length === 0) {
    console.error('deploy: nothing deployable after resolving job paths.');
    process.exit(1);
  }

  const paramStr = Object.keys(params).length
    ? ` with ${Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`
    : '';
  const header = `${plan.length} app(s) → ${env}${branch ? ` @ ${branch}` : ''}${paramStr}`;

  if (flags.has('--dry-run')) {
    console.log(`🔎 Dry run — would trigger ${header}:`);
    for (const p of plan) console.log(`   ${p.name}  (${p.jobPath})`);
    return;
  }

  if (!flags.has('--yes')) {
    console.log(`Will deploy ${header}:`);
    for (const p of plan) console.log(`   ${p.name}`);
    const answer = prompt('Proceed? [y/N]');
    if (!answer || !/^y(es)?$/i.test(answer.trim())) {
      console.log('Aborted.');
      return;
    }
  }

  let ok = 0;
  for (const p of plan) {
    try {
      const res = await client.triggerDeployment(p.jenkins, { env, branch, params });
      console.log(`✅ ${p.name} → ${env} (HTTP ${res.status})${res.queueUrl ? ` — ${res.queueUrl}` : ''}`);
      ok++;
    } catch (err) {
      console.error(`❌ ${p.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nTriggered ${ok}/${plan.length}.`);
}

if (import.meta.main)
  main().catch((err) => {
    console.error('❌ Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
