#!/usr/bin/env bun

/**
 * jenk  (installed as a shell function)
 *
 * Resolve an app by name/alias and show its latest Jenkins build. The hard part
 * — turning app + env into a Jenkins job path (multibranch or not, per-env
 * overrides) — lives in the config-driven Jenkins client; this is the thin
 * command that wires it to the app registry.
 *
 * Usage (after rubato-setup):
 *   jenk <app> [env]              # latest build (optionally for an env, e.g. stage)
 *   jenk <app> [env] --success    # latest *successful* build
 *
 * Needs Jenkins config + secrets (run rubato-init): jenkins.baseUrl in
 * ~/.rubato/config.json (or JENKINS_URL) and JENKINS_USER + JENKINS_API_TOKEN in
 * ~/.rubato/.env, plus a `jenkins` api entry on the app in ~/.rubato/apps.json.
 */

import { type BuildFilter, buildStatus, fmtDuration, resolveAppJenkins } from '../api/jenkins';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const [query, env] = positional;

  if (!query) {
    console.error('usage: jenk <app> [env] [--success]');
    process.exit(1);
  }

  const { app, jenkins, client } = await resolveAppJenkins(query);
  const filter: BuildFilter | undefined = flags.has('--success') ? { status: 'success' } : undefined;
  const build = await client.getLatestBuildForApp(jenkins, { env, filter });

  if (!build) {
    console.error(`No matching build for ${app.name}${env ? ` (env ${env})` : ''}.`);
    process.exit(1);
  }

  console.log(`Latest build for ${env ? `${app.name} [${env}]` : app.name}:`);
  console.log(`  Build:    #${build.number}${build.displayName ? ` (${build.displayName})` : ''}`);
  console.log(`  Status:   ${buildStatus(build)}`);
  console.log(`  When:     ${new Date(build.timestamp).toISOString()}`);
  console.log(`  Duration: ${fmtDuration(build.duration)}`);
  console.log(`  URL:      ${build.url}`);
}

if (import.meta.main)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
