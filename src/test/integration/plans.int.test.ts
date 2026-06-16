/**
 * Integration: the Plans API through `route()` — create, list, get, edit (update
 * content via POST with id), validation, and delete.
 */

import { describe, expect, test } from 'bun:test';
import type { Plan } from '../../shared/plans';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

const del = async (path: string): Promise<Response> => {
  const { route } = await import('../../server/router');
  return route(new Request(`http://localhost${path}`, { method: 'DELETE' }));
};

describe('plans CRUD', () => {
  test('create → list → get → edit → delete', async () => {
    const created = (await (
      await apiPost('/api/plans', { title: 'Q2 remediation', app: 'billing', content: '# Plan\n- patch lodash' })
    ).json()) as Plan;
    expect(created.id).toBeTruthy();
    expect(created.title).toBe('Q2 remediation');
    expect(created.app).toBe('billing');

    const list = (await (await apiGet('/api/plans')).json()) as Plan[];
    expect(list.some((p) => p.id === created.id)).toBe(true);

    const fetched = (await (await apiGet(`/api/plans/${created.id}`)).json()) as Plan;
    expect(fetched.content).toContain('patch lodash');

    // Edit = POST with the id (same path the UI uses).
    const edited = (await (
      await apiPost('/api/plans', { id: created.id, title: 'Q2 remediation v2', content: '# Plan\n- done' })
    ).json()) as Plan;
    expect(edited.id).toBe(created.id);
    expect(edited.title).toBe('Q2 remediation v2');
    expect(edited.content).toBe('# Plan\n- done');

    expect(await (await del(`/api/plans/${created.id}`)).json()).toEqual({ deleted: true });
    expect((await apiGet(`/api/plans/${created.id}`)).status).toBe(404);
  });

  test('rejects a plan with no title or content', async () => {
    expect((await apiPost('/api/plans', { title: '', content: 'x' })).status).toBe(400);
    expect((await apiPost('/api/plans', { title: 't' })).status).toBe(400);
  });
});
