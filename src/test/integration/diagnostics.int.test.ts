/**
 * Integration: the diagnostics admin API + the output-file download route.
 * Writes a real diagnostic artifact via the session, then drives the routes
 * in-process — list/content/download under the admin gate, plus the non-admin
 * /api/files/download streaming an attachment.
 */

import { describe, expect, test } from 'bun:test';
import { clearConfigCache, setUiConfig } from '../../lib/config';
import { startDiagnostics } from '../../lib/diagnostics';
import { apiGet } from '../harness';
import { useHarness } from '../index';

const _h = useHarness();

/** Write one diagnostic artifact pair and return its report's relative path. */
async function seedDiagnostic(): Promise<string> {
  const d = startDiagnostics({ activity: 'int-test', intent: 'exercise admin routes', console: false });
  d.step('a step');
  d.warn('a warning');
  const res = await d.finish('warn');
  // Convert the absolute report path to its output-dir-relative form.
  return (res.reportPath as string).split('/diagnostics/')[1]
    ? `diagnostics/${(res.reportPath as string).split('/diagnostics/')[1]}`
    : '';
}

async function enableAdmin(on: boolean): Promise<void> {
  await setUiConfig({ admin: on });
  clearConfigCache();
}

describe('diagnostics admin API', () => {
  test('404s entirely when admin is disabled', async () => {
    await enableAdmin(false);
    expect((await apiGet('/api/admin/diagnostics')).status).toBe(404);
  });

  test('lists, reads, and downloads a diagnostic when admin is enabled', async () => {
    await seedDiagnostic();
    await enableAdmin(true);

    const listRes = await apiGet('/api/admin/diagnostics');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ path: string; activity: string; status: string }>;
    const mine = list.find((d) => d.activity === 'int-test');
    expect(mine).toBeDefined();
    expect(mine?.status).toBe('warn');

    const contentRes = await apiGet(`/api/admin/diagnostics/content?path=${encodeURIComponent(mine?.path as string)}`);
    expect(contentRes.status).toBe(200);
    const content = (await contentRes.json()) as { content: string };
    expect(content.content).toContain('rubato.diagnostic/1');

    const dl = await apiGet(`/api/admin/diagnostics/download?path=${encodeURIComponent(mine?.path as string)}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('attachment');

    await enableAdmin(false);
  });

  test('refuses a non-diagnostics path even when admin is on', async () => {
    await enableAdmin(true);
    const res = await apiGet('/api/admin/diagnostics/content?path=../../etc/passwd');
    expect(res.status).toBeGreaterThanOrEqual(400);
    await enableAdmin(false);
  });
});

describe('/api/files/download', () => {
  test('streams an output file as an attachment', async () => {
    const path = await seedDiagnostic();
    const res = await apiGet(`/api/files/download?path=${encodeURIComponent(path)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(await res.text()).toContain('rubato.diagnostic/1');
  });

  test('400 without a path', async () => {
    expect((await apiGet('/api/files/download')).status).toBe(400);
  });
});
