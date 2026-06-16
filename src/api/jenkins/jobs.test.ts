import { describe, expect, test } from 'bun:test';
import { parseBranchFromConfigXml, resolveJobSegments, resolveJobUrlPath, toJobUrlPath } from './jobs';
import type { JenkinsAppApi } from './types';

describe('resolveJobSegments', () => {
  test('non-multibranch: project folders only', () => {
    const app: JenkinsAppApi = { name: 'jenkins', project: 'Deploys/svc' };
    expect(resolveJobSegments(app)).toEqual(['Deploys', 'svc']);
  });

  test('multibranch appends the branch', () => {
    const app: JenkinsAppApi = { name: 'jenkins', project: 'Deploys/svc', multibranch: true };
    expect(resolveJobSegments(app, { branch: 'main' })).toEqual(['Deploys', 'svc', 'main']);
  });

  test('precedence: env override > app > global default', () => {
    const app: JenkinsAppApi = {
      name: 'jenkins',
      project: 'Deploys/svc',
      multibranch: false,
      envs: [{ envName: 'stage', multibranch: true, branch: 'stage' }],
    };
    // env says multibranch + default branch "stage"
    expect(resolveJobSegments(app, { env: 'stage' })).toEqual(['Deploys', 'svc', 'stage']);
    // global default would make it multibranch, but the app setting (false) wins
    expect(resolveJobSegments(app, { env: 'dev', defaults: { multibranch: true }, branch: 'x' })).toEqual([
      'Deploys',
      'svc',
    ]);
  });

  test('env projectName overrides the app project', () => {
    const app: JenkinsAppApi = {
      name: 'jenkins',
      project: 'svc',
      envs: [{ envName: 'prod', projectName: 'Prod/svc' }],
    };
    expect(resolveJobSegments(app, { env: 'prod' })).toEqual(['Prod', 'svc']);
  });

  test('explicit env jobPath short-circuits everything', () => {
    const app: JenkinsAppApi = {
      name: 'jenkins',
      project: 'ignored',
      multibranch: true,
      envs: [{ envName: 'dev', jobPath: 'Custom/Path/job-x' }],
    };
    expect(resolveJobSegments(app, { env: 'dev' })).toEqual(['Custom', 'Path', 'job-x']);
  });

  test('throws when no project is configured', () => {
    expect(() => resolveJobSegments({ name: 'jenkins' })).toThrow(/no project configured/);
  });

  test('throws when multibranch but no branch resolvable', () => {
    const app: JenkinsAppApi = { name: 'jenkins', project: 'svc', multibranch: true };
    expect(() => resolveJobSegments(app)).toThrow(/multibranch but no branch/);
  });
});

describe('toJobUrlPath / resolveJobUrlPath', () => {
  test('builds job/ segments and url-encodes', () => {
    expect(toJobUrlPath(['My Folder', 'main'])).toBe('job/My%20Folder/job/main');
  });

  test('resolveJobUrlPath end-to-end', () => {
    const app: JenkinsAppApi = { name: 'jenkins', project: 'Deploys/svc', multibranch: true };
    expect(resolveJobUrlPath(app, { branch: 'main' })).toBe('job/Deploys/job/svc/job/main');
  });
});

describe('parseBranchFromConfigXml', () => {
  test('extracts and strips the */ prefix from a git BranchSpec', () => {
    const xml = '<x><hudson.plugins.git.BranchSpec><name>*/main</name></hudson.plugins.git.BranchSpec></x>';
    expect(parseBranchFromConfigXml(xml)).toBe('main');
  });

  test('falls back to a generic <branches><name>', () => {
    const xml = '<branches><thing><name>release/2.0</name></thing></branches>';
    expect(parseBranchFromConfigXml(xml)).toBe('release/2.0');
  });

  test('returns null when nothing matches', () => {
    expect(parseBranchFromConfigXml('<project/>')).toBeNull();
  });
});
