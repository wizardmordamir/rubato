/**
 * Integration: the Vulnerabilities API through `route()` — upsert (per app+scan),
 * the aggregate stats roll-up, per-app + clear deletes, and associating a scan with
 * the deployed (Jenkins/Harness) app it came from.
 */

import { describe, expect, test } from 'bun:test';
import type { DeployApp, VulnerabilitiesResponse } from '../../shared/vulnerabilities';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

async function fetchRoute(path: string, init?: RequestInit): Promise<Response> {
  const { route } = await import('../../server/router');
  return route(new Request(`http://localhost${path}`, init));
}

describe('vulnerabilities API', () => {
  test('upsert → stats roll-up → delete one → clear', async () => {
    await fetchRoute('/api/vulnerabilities', { method: 'DELETE' }); // start clean

    await apiPost('/api/vulnerabilities', { app: 'alpha', scanType: 'SAST', critical: 2, high: 3 });
    await apiPost('/api/vulnerabilities', { app: 'beta', scanType: 'DAST', low: 4 });
    // re-upsert alpha/SAST → replaces, not duplicates
    const after = (await (
      await apiPost('/api/vulnerabilities', { app: 'alpha', scanType: 'SAST', critical: 5 })
    ).json()) as VulnerabilitiesResponse;

    const alpha = after.records.find((r) => r.app === 'alpha' && r.scanType === 'SAST');
    expect(alpha?.critical).toBe(5);
    expect(alpha?.high).toBe(0); // replaced, the earlier high:3 is gone
    expect(alpha?.total).toBe(5);
    expect(after.records).toHaveLength(2); // alpha + beta, no dup
    expect(after.stats.apps).toBe(2);
    expect(after.stats.totals.critical).toBe(5);
    expect(after.stats.appsBySeverity.critical).toEqual(['alpha']);
    expect(after.stats.appsBySeverity.low).toEqual(['beta']);

    const get = (await (await apiGet('/api/vulnerabilities')).json()) as VulnerabilitiesResponse;
    expect(get.records).toHaveLength(2);

    const delOne = (await (
      await fetchRoute('/api/vulnerabilities/alpha?scanType=SAST', { method: 'DELETE' })
    ).json()) as VulnerabilitiesResponse;
    expect(delOne.records).toHaveLength(1);
    expect(delOne.records[0].app).toBe('beta');

    const cleared = (await (
      await fetchRoute('/api/vulnerabilities', { method: 'DELETE' })
    ).json()) as VulnerabilitiesResponse;
    expect(cleared.records).toHaveLength(0);
    expect(cleared.stats.apps).toBe(0);
  });

  test('vuln-free apps surface in the stats', async () => {
    await fetchRoute('/api/vulnerabilities', { method: 'DELETE' });
    await apiPost('/api/vulnerabilities', { app: 'clean', scanType: 'SAST' });
    await apiPost('/api/vulnerabilities', { app: 'risky', scanType: 'SAST', high: 1 });
    const res = (await (await apiGet('/api/vulnerabilities')).json()) as VulnerabilitiesResponse;
    expect(res.stats.vulnFree).toEqual(['clean']);
  });

  test('rejects an upsert with no app', async () => {
    expect((await apiPost('/api/vulnerabilities', { scanType: 'SAST' })).status).toBe(400);
  });

  test('deleting an unknown app/scan is a 404', async () => {
    expect((await fetchRoute('/api/vulnerabilities/nope?scanType=SAST', { method: 'DELETE' })).status).toBe(404);
  });

  test('round-trips informational + issue types and rolls them into sharedIssues', async () => {
    await fetchRoute('/api/vulnerabilities', { method: 'DELETE' });
    await apiPost('/api/vulnerabilities', {
      app: 'web',
      scanType: 'SAST',
      high: 3,
      informational: 2,
      issueTypes: [
        { name: 'SQL Injection', count: 3, severity: 'high' },
        { name: 'HTML Comments', count: 2, severity: 'informational' },
      ],
    });
    const res = (await (
      await apiPost('/api/vulnerabilities', {
        app: 'api',
        scanType: 'DAST',
        critical: 1,
        issueTypes: [{ name: 'SQL Injection', count: 1, severity: 'critical' }],
      })
    ).json()) as VulnerabilitiesResponse;

    const web = res.records.find((r) => r.app === 'web');
    expect(web?.informational).toBe(2);
    expect(web?.total).toBe(5); // high 3 + informational 2
    expect(web?.issueTypes).toHaveLength(2);

    expect(res.stats.totals.informational).toBe(2);
    const sqli = res.stats.sharedIssues.find((i) => i.type === 'SQL Injection');
    expect(sqli?.appCount).toBe(2); // shared across web + api
    expect(sqli?.totalCount).toBe(4);
    expect(sqli?.severity).toBe('critical');
  });

  test('import-pdf rejects a missing file (400) and a non-PDF (400)', async () => {
    const noFile = new FormData();
    expect((await fetchRoute('/api/vulnerabilities/import-pdf', { method: 'POST', body: noFile })).status).toBe(400);

    const wrongType = new FormData();
    wrongType.append('file', new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect((await fetchRoute('/api/vulnerabilities/import-pdf', { method: 'POST', body: wrongType })).status).toBe(400);
  });

  test('serving a report for a record with no stored PDF is a 404', async () => {
    await fetchRoute('/api/vulnerabilities', { method: 'DELETE' });
    await apiPost('/api/vulnerabilities', { app: 'noreport', scanType: 'SAST', high: 1 });
    expect((await fetchRoute('/api/vulnerabilities/noreport/report?scanType=SAST')).status).toBe(404);
  });

  test('plan generation is 404 for an unknown record and saves a plan for a real one', async () => {
    await fetchRoute('/api/vulnerabilities', { method: 'DELETE' });
    expect((await fetchRoute('/api/vulnerabilities/ghost/plan?scanType=SAST', { method: 'POST' })).status).toBe(404);

    await apiPost('/api/vulnerabilities', {
      app: 'planme',
      scanType: 'SAST',
      high: 2,
      issueTypes: [{ name: 'SQL Injection', count: 2, severity: 'high' }],
    });
    // The harness wires a fake LLM upstream, so the full generate → save flow runs.
    const res = await fetchRoute('/api/vulnerabilities/planme/plan?scanType=SAST', { method: 'POST' });
    expect(res.status).toBe(200);
    const { planId, title } = (await res.json()) as { planId: string; title: string };
    expect(planId).toBeTruthy();
    expect(title).toContain('planme');

    // The generated plan lands in the Plans table.
    const plans = (await (await apiGet('/api/plans')).json()) as Array<{ id: string; app: string | null }>;
    expect(plans.some((p) => p.id === planId && p.app === 'planme')).toBe(true);
  });
});

describe('vulnerabilities ↔ deployed-app association', () => {
  test('deploy-apps lists registry apps that deploy via jenkins/harness', async () => {
    // The seeded registry has "app" (jenkins) and "billing" (quay only).
    const deploy = (await (await apiGet('/api/vulnerabilities/deploy-apps')).json()) as DeployApp[];
    const appEntry = deploy.find((a) => a.name === 'app');
    expect(appEntry?.deploysVia).toEqual(['jenkins']);
    expect(deploy.some((a) => a.name === 'billing')).toBe(false); // quay isn't a deploy pipeline
  });

  test('link a scan to a deploy app, preserve it across re-import, then clear it', async () => {
    await fetchRoute('/api/vulnerabilities', { method: 'DELETE' });
    await apiPost('/api/vulnerabilities', { app: 'web', scanType: 'SAST', high: 1 });

    // Associate the scan with the deployed "app".
    const linked = (await (
      await apiPost('/api/vulnerabilities/web/link?scanType=SAST', { linkedApp: 'app' })
    ).json()) as VulnerabilitiesResponse & { record: { linkedApp?: string } };
    expect(linked.record.linkedApp).toBe('app');
    expect(linked.records.find((r) => r.app === 'web')?.linkedApp).toBe('app');

    // A re-import/upsert that doesn't carry a link must NOT drop the association.
    const reimport = (await (
      await apiPost('/api/vulnerabilities', { app: 'web', scanType: 'SAST', high: 2 })
    ).json()) as VulnerabilitiesResponse;
    const web = reimport.records.find((r) => r.app === 'web');
    expect(web?.high).toBe(2); // replaced
    expect(web?.linkedApp).toBe('app'); // preserved

    // Clearing with null removes the association.
    const cleared = (await (
      await apiPost('/api/vulnerabilities/web/link?scanType=SAST', { linkedApp: null })
    ).json()) as VulnerabilitiesResponse & { record: { linkedApp?: string } };
    expect(cleared.record.linkedApp).toBeUndefined();
  });

  test('linking to an unknown app is a 400, and an unknown record is a 404', async () => {
    await fetchRoute('/api/vulnerabilities', { method: 'DELETE' });
    await apiPost('/api/vulnerabilities', { app: 'web', scanType: 'SAST', high: 1 });

    expect((await apiPost('/api/vulnerabilities/web/link?scanType=SAST', { linkedApp: 'ghost-app' })).status).toBe(400);
    expect((await apiPost('/api/vulnerabilities/nope/link?scanType=SAST', { linkedApp: 'app' })).status).toBe(404);
  });
});
