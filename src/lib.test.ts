import { describe, expect, test } from 'bun:test';
import * as root from './lib';
import * as deployBarrel from './lib/deploy';

describe('public library barrels', () => {
  test('root barrel exposes flat utilities', () => {
    expect(typeof root.createApiClient).toBe('function');
    expect(typeof root.toTable).toBe('function');
    expect(typeof root.toCsv).toBe('function');
    expect(typeof root.loadApps).toBe('function');
    expect(typeof root.getAppApi).toBe('function');
    expect(typeof root.loadConfig).toBe('function');
    expect(typeof root.requireEnv).toBe('function');
    expect(typeof root.jenkinsFromConfig).toBe('function');
    expect(typeof root.quayFromConfig).toBe('function');
    expect(typeof root.gitlabFromConfig).toBe('function');
  });

  test('root barrel exposes domain namespaces', () => {
    expect(typeof root.git.currentBranch).toBe('function');
    expect(typeof root.deploy.verifyDeployList).toBe('function');
    expect(typeof root.jenkins.createJenkinsClient).toBe('function');
    expect(typeof root.quay.createQuayClient).toBe('function');
    expect(typeof root.gitlab.createGitlabClient).toBe('function');
  });

  test('deploy barrel re-exports the pure core + the IO glue', () => {
    expect(typeof deployBarrel.verifyEntry).toBe('function'); // api/deploy
    expect(typeof deployBarrel.parseDeployList).toBe('function'); // lib/deploy
    expect(typeof deployBarrel.collectApps).toBe('function');
    expect(typeof deployBarrel.verifyDeployList).toBe('function');
    expect(typeof deployBarrel.buildDeployClients).toBe('function');
    expect(typeof deployBarrel.summarizeVulnerabilities).toBe('function');
  });
});
