#!/usr/bin/env bun
/**
 * init  (installed as `rubato-init`)
 *
 * Scaffolds the per-machine config so a new user can fill in details and go:
 *   - ~/.rubato/config.json gains a `jenkins` block (base URL + default
 *     conventions) if it doesn't have one
 *   - ~/.rubato/.env is created (or topped up) with the secret keys clients read
 *
 * Idempotent: existing values are never overwritten — only missing pieces are
 * added. Edit the files afterward to fill in your real values.
 *
 * Usage:
 *   bun run src/scripts/init.ts            # scaffold config + .env
 *   bun run src/scripts/init.ts --dry-run  # show what would change
 */

import { $ } from 'bun';
import type { JenkinsGlobalConfig } from '../lib/appApis';
import { CONFIG_FILE, ENV_FILE, loadConfig, RUBATO_HOME, saveConfig } from '../lib/config';

const STARTER_JENKINS: JenkinsGlobalConfig = {
  baseUrl: '',
  defaults: {
    multibranch: false,
    envs: ['dev', 'test', 'stage', 'prod'],
    pipelines: ['deploy', 'scan'],
  },
};

const ENV_KEYS = [
  'JENKINS_URL',
  'JENKINS_USER',
  'JENKINS_API_TOKEN',
  'QUAY_URL',
  'QUAY_API_TOKEN',
  'GITLAB_URL',
  'GITLAB_API_TOKEN',
  // Splunk search (the query builder's Run button)
  'SPLUNK_URL',
  'SPLUNK_TOKEN',
  // Datadog (two keys: API + application)
  'DATADOG_URL',
  'DATADOG_API_KEY',
  'DATADOG_APP_KEY',
  // Dynatrace (Api-Token auth)
  'DYNATRACE_URL',
  'DYNATRACE_API_TOKEN',
  // GitHub (bearer; URL only for GitHub Enterprise)
  'GITHUB_URL',
  'GITHUB_TOKEN',
  // Rancher (bearer)
  'RANCHER_URL',
  'RANCHER_TOKEN',
  // OpenShift / k8s (bearer). Set the direct cluster API, OR the web-console
  // proxy fallback (OPENSHIFT_CONSOLE_*) for when the API server is blocked.
  'OPENSHIFT_URL',
  'OPENSHIFT_TOKEN',
  'OPENSHIFT_CONSOLE_URL',
  'OPENSHIFT_CONSOLE_TOKEN',
  // Harness (x-api-key + account id)
  'HARNESS_URL',
  'HARNESS_API_KEY',
  'HARNESS_ACCOUNT_ID',
];

const ENV_TEMPLATE = [
  '# rubato secrets — read by service clients (Jenkins, ...). Keep this private.',
  ...ENV_KEYS.map((k) => `${k}=`),
  '',
].join('\n');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const changes: string[] = [];

  // 1. Ensure config.json exists and has a jenkins block.
  const cfg = await loadConfig(); // creates a default config.json if missing
  if (!cfg.jenkins) {
    cfg.jenkins = STARTER_JENKINS;
    changes.push(`add a starter "jenkins" block to ${CONFIG_FILE}`);
    if (!dryRun) await saveConfig(cfg);
  }

  // 2. Ensure ~/.rubato/.env exists and has the expected keys (values untouched).
  const envFile = Bun.file(ENV_FILE);
  if (!(await envFile.exists())) {
    changes.push(`create ${ENV_FILE} with ${ENV_KEYS.join(', ')}`);
    if (!dryRun) {
      await $`mkdir -p ${RUBATO_HOME}`.quiet();
      await Bun.write(ENV_FILE, ENV_TEMPLATE);
    }
  } else {
    const text = await envFile.text();
    const missing = ENV_KEYS.filter((k) => !new RegExp(`^\\s*${k}=`, 'm').test(text));
    if (missing.length) {
      changes.push(`append ${missing.join(', ')} to ${ENV_FILE}`);
      if (!dryRun) {
        const sep = text.endsWith('\n') ? '' : '\n';
        await Bun.write(ENV_FILE, `${text}${sep}${missing.map((k) => `${k}=`).join('\n')}\n`);
      }
    }
  }

  // Report.
  if (changes.length === 0) {
    console.log('✅ Already initialized — config.json and .env are in place.');
  } else if (dryRun) {
    console.log('🔎 Dry run — would:');
    for (const c of changes) console.log(`  - ${c}`);
  } else {
    console.log('✅ Initialized:');
    for (const c of changes) console.log(`  - ${c}`);
  }

  console.log(
    [
      '',
      'Next:',
      `  1. Put your Jenkins URL + token in ${ENV_FILE} (JENKINS_URL/JENKINS_USER/JENKINS_API_TOKEN).`,
      `  2. Set defaults under "jenkins" in ${CONFIG_FILE} (e.g. multibranch, envs).`,
      '  3. Add a jenkins api block to apps in ~/.rubato/apps.json, e.g.:',
      '       "apis": [{ "name": "jenkins", "project": "Deploys/my-app", "multibranch": true,',
      '                  "envs": [{ "envName": "stage", "branch": "main" }] }]',
    ].join('\n'),
  );
}

if (import.meta.main)
  main().catch((err) => {
    console.error('❌ Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
