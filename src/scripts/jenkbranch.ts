#!/usr/bin/env bun
/**
 * jenkbranch  (installed as a shell function)
 *
 * Show the git branch a Jenkins job builds, read from its config.xml. Most
 * useful for non-multibranch jobs (where the branch lives in config); for a
 * multibranch pipeline, pass the branch to target that branch's job.
 *
 * Usage (after rubato-setup):  jenkbranch <app> [env] [branch]
 */

import { resolveAppJenkins } from '../api/jenkins';

async function main(): Promise<void> {
  const [query, env, branch] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!query) {
    console.error('usage: jenkbranch <app> [env] [branch]');
    process.exit(1);
  }

  const { app, jenkins, client } = await resolveAppJenkins(query);
  const jobPath = client.resolveJobPath(jenkins, { env, branch });
  const found = await client.getJobBranch(jobPath);

  console.log(`${app.name}${env ? ` [${env}]` : ''}: ${found ?? 'no branch found in config.xml'}`);
  console.log(`  Job path: ${jobPath}`);
}

if (import.meta.main)
  main().catch((err) => {
    console.error('❌ Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
