/**
 * Integration: the setup-scripts admin API. Drives the in-process route() handler —
 * list (which seeds the bundled defaults), read, edit, reset-to-template, create +
 * delete a custom script — all under the admin gate, plus the 404 when admin is off.
 */

import { describe, expect, test } from 'bun:test';
import { clearConfigCache, setUiConfig } from '../../lib/config';
import { route } from '../../server/router';
import type { SetupScriptDoc, SetupScriptInfo } from '../../shared/types';
import { apiGet, apiPost } from '../harness';
import { useHarness } from '../index';

const _h = useHarness();

async function enableAdmin(on: boolean): Promise<void> {
  await setUiConfig({ admin: on });
  clearConfigCache();
}
const apiDelete = (path: string) => route(new Request(`http://x${path}`, { method: 'DELETE' }));

describe('setup-scripts admin API', () => {
  test('404s entirely when admin is disabled', async () => {
    await enableAdmin(false);
    expect((await apiGet('/api/admin/setup-scripts')).status).toBe(404);
  });

  test('lists (seeding defaults), reads, edits, resets, creates + deletes', async () => {
    await enableAdmin(true);

    const listRes = await apiGet('/api/admin/setup-scripts');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as SetupScriptInfo[];
    const cf = list.find((s) => s.name === '70-cloudflare.sh');
    expect(cf).toBeDefined();
    expect(cf?.isTemplate).toBe(true);
    expect(cf?.path).toContain('setup-scripts');

    const readRes = await apiGet('/api/admin/setup-scripts/70-cloudflare.sh');
    expect(readRes.status).toBe(200);
    const doc = (await readRes.json()) as SetupScriptDoc;
    expect(doc.content).toContain('api.cloudflare.com');

    const saveRes = await apiPost('/api/admin/setup-scripts/70-cloudflare.sh', {
      content: `${doc.content}\n# my note\n`,
    });
    expect(saveRes.status).toBe(200);
    expect(((await saveRes.json()) as SetupScriptDoc).content).toContain('# my note');

    const resetRes = await apiPost('/api/admin/setup-scripts/70-cloudflare.sh/reset', {});
    expect(resetRes.status).toBe(200);
    expect(((await resetRes.json()) as SetupScriptDoc).content).not.toContain('# my note');

    const created = await apiPost('/api/admin/setup-scripts/99-custom.sh', {
      content: '#!/usr/bin/env bash\necho hi\n',
    });
    expect(created.status).toBe(200);

    const delRes = await apiDelete('/api/admin/setup-scripts/99-custom.sh');
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as { deleted: boolean }).deleted).toBe(true);

    await enableAdmin(false);
  });

  test('seed endpoint reports which defaults it created (idempotent)', async () => {
    await enableAdmin(true);
    await apiGet('/api/admin/setup-scripts'); // ensure all defaults present
    const res = await apiPost('/api/admin/setup-scripts/seed', {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created: string[] }).created).toEqual([]);
    await enableAdmin(false);
  });

  test('refuses an unsafe / non-script name even when admin is on', async () => {
    await enableAdmin(true);
    expect((await apiGet('/api/admin/setup-scripts/..%2f..%2fetc%2fpasswd')).status).toBe(404);
    expect((await apiPost('/api/admin/setup-scripts/notscript.json', { content: 'x' })).status).toBeGreaterThanOrEqual(
      400,
    );
    await enableAdmin(false);
  });
});
