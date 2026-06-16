/**
 * Seed the (already-isolated) RUBATO_HOME for an integration test: write a
 * config.json whose every service `baseUrl` points at the fake upstream, a
 * registry of test apps (real scaffolded git repos) carrying `apis` that
 * reference those services, and fake credentials so `requireEnv()` succeeds.
 *
 * `seedHome()` returns a `cleanup()` that removes everything it wrote (files,
 * env vars, db) and clears the module caches, so an integration test leaves the
 * shared home pristine for whatever runs next.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from '../lib/apps';
import { APPS_FILE, CONFIG_FILE, ENV_FILE, RUBATO_HOME } from '../lib/config';
import { scaffoldApp } from '../scripts/sandbox';
import { resetRubatoState } from './reset';

/** Token env vars set so each `*FromConfig()` can authenticate against the fake. */
const TOKEN_ENV: Record<string, string> = {
  SPLUNK_TOKEN: 'fake-splunk',
  JENKINS_USER: 'fake-user',
  JENKINS_API_TOKEN: 'fake-jenkins',
  QUAY_API_TOKEN: 'fake-quay',
  GITLAB_API_TOKEN: 'fake-gitlab',
  GITHUB_TOKEN: 'fake-github',
  DATADOG_API_KEY: 'fake-dd-api',
  DATADOG_APP_KEY: 'fake-dd-app',
  DYNATRACE_API_TOKEN: 'fake-dt',
  RANCHER_TOKEN: 'fake-rancher',
  HARNESS_API_KEY: 'fake-harness',
  HARNESS_ACCOUNT_ID: 'acct-1',
  RUBATO_LLM_TOKEN: 'fake-llm',
};

export interface SeededHome {
  home: string;
  codeDir: string;
  apps: AppConfig[];
  /** Look an app up by registry name. */
  app(name: string): AppConfig;
  /** Remove everything this seed wrote and clear caches. Call in afterAll/afterEach. */
  cleanup(): void;
}

/** Build the default test registry: real git repos with apis wired to the fakes. */
async function defaultApps(codeDir: string): Promise<AppConfig[]> {
  await scaffoldApp(codeDir, 'app');
  await scaffoldApp(codeDir, 'billing');
  const mk = (name: string, apis: AppConfig['apis']): AppConfig => ({
    name,
    absolutePath: resolve(codeDir, name),
    dirName: name,
    repoName: name,
    group: null,
    aliases: [],
    apis,
  });
  return [
    mk('app', [
      { name: 'quay', repository: 'team/app' },
      { name: 'gitlab', project: 'app', namespace: 'team' },
      { name: 'jenkins', project: 'Deploys/app' },
      {
        name: 'splunk',
        index: 'main',
        appId: 'app',
        envs: ['dev', 'prod'],
        searches: [{ label: 'Audit', search: '/api/v*/audit' }],
      },
    ]),
    mk('billing', [{ name: 'quay', repository: 'team/billing' }]),
  ];
}

export interface SeedOptions {
  /** Override the test registry (default: an "app" with quay/gitlab/jenkins/splunk + "billing"). */
  apps?: AppConfig[];
}

export async function seedHome(fakeUrl: string, opts: SeedOptions = {}): Promise<SeededHome> {
  const home = RUBATO_HOME;
  const codeDir = resolve(home, 'code');
  mkdirSync(codeDir, { recursive: true });

  // Every service's base URL → a `/<service>` prefix on the one fake upstream.
  const svc = (name: string) => ({ baseUrl: `${fakeUrl}/${name}` });
  const config = {
    codeDirs: [codeDir],
    editor: 'echo',
    ignore: [],
    splunk: svc('splunk'),
    jenkins: svc('jenkins'),
    quay: svc('quay'),
    gitlab: svc('gitlab'),
    github: svc('github'),
    datadog: svc('datadog'),
    dynatrace: svc('dynatrace'),
    rancher: svc('rancher'),
    harness: svc('harness'),
    ai: { provider: 'direct', direct: { baseUrl: `${fakeUrl}/llm`, model: 'fake', path: 'chat/completions' } },
  };
  await Bun.write(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);

  const apps = opts.apps ?? (await defaultApps(codeDir));
  await Bun.write(APPS_FILE, `${JSON.stringify(apps, null, 2)}\n`);

  // Fake creds in process.env (requireEnv checks process.env before the .env file).
  for (const [k, v] of Object.entries(TOKEN_ENV)) process.env[k] = v;

  resetRubatoState();

  const byName = new Map(apps.map((a) => [a.name, a]));

  return {
    home,
    codeDir,
    apps,
    app(name) {
      const a = byName.get(name);
      if (!a) throw new Error(`seeded app not found: ${name}`);
      return a;
    },
    cleanup() {
      for (const k of Object.keys(TOKEN_ENV)) delete process.env[k];
      for (const f of [CONFIG_FILE, APPS_FILE, ENV_FILE]) rmSync(f, { force: true });
      rmSync(codeDir, { recursive: true, force: true });
      resetRubatoState();
    },
  };
}
