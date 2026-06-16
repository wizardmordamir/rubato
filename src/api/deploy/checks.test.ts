import { describe, expect, test } from 'bun:test';
import type { JenkinsBuild } from '../jenkins/types';
import type { QuayTag } from '../quay';
import { type EntryClients, verifyEntry } from './checks';

const SHA = '617b85b647c550db2a54f167fc98cb406bdb69c42f795bcc708c92f28e3e5ae9';
const COMMIT = 'a1c32a4414fea408b4e9472ddb45969a66100c38';

const entry = { app: 'team/my-app', version: '1.1.13.739', commit: COMMIT, sha256: SHA };

const tag = (over: Partial<QuayTag> = {}): QuayTag => ({
  name: '1.1.13.739',
  manifest_digest: `sha256:${SHA}`,
  size: 579787144,
  last_modified: 'Tue, 09 Jun 2026 18:18:15 -0000',
  ...over,
});

const build = (over: Partial<JenkinsBuild> = {}): JenkinsBuild => ({
  number: 740,
  url: 'https://jenkins/job/team/job/my-app/740/',
  result: 'SUCCESS',
  building: false,
  timestamp: 1781029226701,
  duration: 89262,
  changeSets: [{ items: [{ commitId: COMMIT }] }],
  ...over,
});

/** A fully-wired set of capabilities for the happy path; override per test. */
function clients(over: Partial<EntryClients> = {}): EntryClients {
  return {
    quayTag: async () => tag(),
    gitCommit: async () => ({
      message: 'jenkins-logging',
      author: 'Jane Dev',
      date: '2025-06-26 18:22:34 -0500',
    }),
    jenkinsBuild: async () => ({ build: build(), strategy: 'embedded' }),
    ...over,
  };
}

const ctx = (over: Partial<EntryClients> = {}) => ({
  registryMatched: true,
  clients: clients(over),
  now: () => 1781040000000,
});

describe('verifyEntry — happy path (my-app gold fixture)', () => {
  test('PASS with no issues or warnings, and full metadata', async () => {
    const r = await verifyEntry(entry, ctx());
    expect(r.status).toBe('PASS');
    expect(r.issues).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.metadata.quayData?.tagManifestDigest).toBe(`sha256:${SHA}`);
    expect(r.metadata.jenkinsData?.buildNumber).toBe(740);
    expect(r.metadata.gitData?.commitAuthor).toBe('Jane Dev');
  });
});

describe('verifyEntry — hard failures (issue ⇒ FAIL)', () => {
  test('sha256 mismatch', async () => {
    const r = await verifyEntry(entry, ctx({ quayTag: async () => tag({ manifest_digest: 'sha256:deadbeef' }) }));
    expect(r.status).toBe('FAIL');
    expect(r.issues[0]).toContain('sha256 mismatch');
  });

  test('Quay tag not found', async () => {
    const r = await verifyEntry(entry, ctx({ quayTag: async () => null }));
    expect(r.status).toBe('FAIL');
    expect(r.issues[0]).toContain('tag "1.1.13.739" not found');
  });

  test('git commit does not exist', async () => {
    const r = await verifyEntry(entry, ctx({ gitCommit: async () => null }));
    expect(r.status).toBe('FAIL');
    expect(r.issues[0]).toContain('does not exist in git');
  });
});

describe('verifyEntry — soft concerns (warning, still PASS)', () => {
  test('build matched only by build-number heuristic', async () => {
    const r = await verifyEntry(
      entry,
      ctx({ jenkinsBuild: async () => ({ build: build(), strategy: 'buildNumber' }) }),
    );
    expect(r.status).toBe('PASS');
    expect(r.warnings.some((w) => w.includes('build-number heuristic'))).toBe(true);
  });

  test('no Jenkins build found', async () => {
    const r = await verifyEntry(entry, ctx({ jenkinsBuild: async () => ({ build: null, strategy: 'none' }) }));
    expect(r.status).toBe('PASS');
    expect(r.warnings.some((w) => w.includes('no Jenkins build'))).toBe(true);
  });

  test('producing build not SUCCESS', async () => {
    const r = await verifyEntry(
      entry,
      ctx({ jenkinsBuild: async () => ({ build: build({ result: 'FAILURE' }), strategy: 'embedded' }) }),
    );
    expect(r.warnings.some((w) => w.includes('result is FAILURE'))).toBe(true);
  });

  test("commit not among the build's commits", async () => {
    const b = build({ changeSets: [{ items: [{ commitId: 'ffffffffffffffff' }] }] });
    const r = await verifyEntry(entry, ctx({ jenkinsBuild: async () => ({ build: b, strategy: 'embedded' }) }));
    expect(r.status).toBe('PASS');
    expect(r.warnings.some((w) => w.includes('not among build #740 commits'))).toBe(true);
  });
});

describe('verifyEntry — unconfigured services degrade to warnings', () => {
  test('Quay not configured → warning, PASS (digest unverified)', async () => {
    const r = await verifyEntry(entry, {
      registryMatched: true,
      clients: { quayTag: undefined, gitCommit: async () => ({ author: 'x' }) },
    });
    expect(r.status).toBe('PASS');
    expect(r.warnings.some((w) => w.includes('Quay not configured'))).toBe(true);
  });

  test('Git not configured with a commit present → warning', async () => {
    const r = await verifyEntry(entry, { registryMatched: true, clients: { quayTag: async () => tag() } });
    expect(r.warnings.some((w) => w.includes('Git not configured'))).toBe(true);
  });

  test('app not in registry → warning', async () => {
    const r = await verifyEntry(entry, { registryMatched: false, clients: {} });
    expect(r.warnings.some((w) => w.includes('not found in registry'))).toBe(true);
  });

  test('a throwing capability degrades to a warning, never throws', async () => {
    const r = await verifyEntry(
      entry,
      ctx({
        quayTag: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(r.warnings.some((w) => w.includes('Quay check failed: boom'))).toBe(true);
  });
});
