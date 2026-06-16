/**
 * Integration: the deploy-list verifier — the richest multi-source flow. Builds
 * the REAL Jenkins/Quay/GitLab clients (pointed at the fake upstream) and runs the
 * real verify engine over hand-crafted deploy entries, covering PASS, the hard
 * digest-mismatch FAIL, a missing-commit FAIL, and a Quay-404 FAIL.
 */

import { describe, expect, test } from 'bun:test';
import type { DeployEntry } from '../../api/deploy/types';
import { loadApps } from '../../lib/apps';
import { buildDeployClients } from '../../lib/deploy/clients';
import { verifyDeployList } from '../../lib/deploy/verify';
import { aDeployEntry, useHarness } from '../index';

const h = useHarness();

const FIXED_NOW = () => Date.parse('2026-01-02T00:00:00Z');
// aDeployEntry is PASS-shaped (sha256 matches the fake Quay digest); override to break it.
const entry = aDeployEntry;

async function verify(entries: DeployEntry[]) {
  const apps = await loadApps();
  const clients = await buildDeployClients(apps, { jenkins: true, quay: true, gitlab: true });
  return { clients, report: await verifyDeployList(entries, apps, clients, { env: 'prod', now: FIXED_NOW }) };
}

describe('deploy verify integration', () => {
  test('builds the live clients for configured apps', async () => {
    const clients = await buildDeployClients(await loadApps(), { jenkins: true, quay: true, gitlab: true });
    expect(clients.jenkins).not.toBeNull();
    expect(clients.quay).not.toBeNull();
    expect(clients.gitlab).not.toBeNull();
  });

  test('a correct entry PASSes (digest matches Quay, commit exists in GitLab)', async () => {
    h.fake.reset();
    const { report } = await verify([entry()]);
    expect(report.summary.totalEntries).toBe(1);
    expect(report.summary.failed).toBe(0);
    const r = report.results[0];
    expect(r.status).toBe('PASS');
    expect(r.issues).toEqual([]);
    expect(r.metadata.quayData?.tagManifestDigest).toBe('sha256:deadbeef');

    // The verifier really queried Quay (image) and GitLab (commit).
    expect(h.fake.requests.some((q) => q.service === 'quay')).toBe(true);
    expect(h.fake.requests.some((q) => q.service === 'gitlab')).toBe(true);
  });

  test('a sha256 that disagrees with Quay FAILs with a digest-mismatch issue', async () => {
    h.fake.reset();
    const { report } = await verify([entry({ sha256: '0000bad0' })]);
    const r = report.results[0];
    expect(r.status).toBe('FAIL');
    expect(r.issues.join(' ')).toMatch(/sha256 mismatch/i);
    expect(report.summary.failed).toBe(1);
  });

  test("a commit GitLab 404s on FAILs with a 'does not exist' issue", async () => {
    h.fake.reset();
    h.fake.handler = (ctx) =>
      ctx.service === 'gitlab' && ctx.path.includes('/repository/commits/')
        ? ctx.json({ message: '404 Commit Not Found' }, 404)
        : undefined;
    const { report } = await verify([entry()]);
    const r = report.results[0];
    expect(r.status).toBe('FAIL');
    expect(r.issues.join(' ')).toMatch(/does not exist/i);
  });

  test("a Quay tag that doesn't exist FAILs with a 'not found' issue", async () => {
    h.fake.reset();
    h.fake.handler = (ctx) =>
      ctx.service === 'quay' && ctx.path.endsWith('/tag/') ? ctx.json({ tags: [] }, 200) : undefined;
    const { report } = await verify([entry()]);
    const r = report.results[0];
    expect(r.status).toBe('FAIL');
    expect(r.issues.join(' ')).toMatch(/not found/i);
  });

  test('a mixed list aggregates per-entry PASS/FAIL into the summary', async () => {
    h.fake.reset();
    const { report } = await verify([entry(), entry({ sha256: '0000bad0' })]);
    expect(report.summary.totalEntries).toBe(2);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(1);
    expect(report.timestamp).toBe('2026-01-02T00:00:00.000Z');
  });
});
