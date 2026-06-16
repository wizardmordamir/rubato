/**
 * Integration: the ServiceNow API through `route()` — connection + saved-request
 * CRUD, credential gating (412 without SN_* env, never echoing the secret), the
 * write gate (table_write blocked without allowWrites + SN_ALLOW_WRITES), and a
 * full table_read run against a fake ServiceNow upstream (SN_<KEY>_URL points the
 * client at it; the Basic auth header is asserted).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { SnConnectionWithStatus, SnRunResult, SnSavedRequest } from '../../shared/servicenow';
import { apiGet, apiPost, type FakeUpstream, startFakeUpstream, useHarness } from '../index';

useHarness();

const CONN = {
  name: 'prod snow',
  instanceUrl: 'https://dev99999.service-now.com',
  username: 'reader',
  envKey: 'TESTSNOW',
  defaultTable: 'incident',
  allowWrites: false,
};

const createConn = async (overrides: Partial<typeof CONN> = {}): Promise<SnConnectionWithStatus> => {
  const res = await apiPost('/api/servicenow-connections', { ...CONN, ...overrides });
  expect(res.status).toBe(200);
  return (await res.json()) as SnConnectionWithStatus;
};

const del = async (path: string): Promise<Response> => {
  const { route } = await import('../../server/router');
  return route(new Request(`http://localhost${path}`, { method: 'DELETE' }));
};

afterEach(() => {
  delete process.env.SN_TESTSNOW_TOKEN;
  delete process.env.SN_TESTSNOW_PASSWORD;
  delete process.env.SN_TESTSNOW_USERNAME;
  delete process.env.SN_TESTSNOW_URL;
  delete process.env.SN_ALLOW_WRITES;
});

describe('servicenow-connections CRUD', () => {
  test('create → list (with credential status) → delete', async () => {
    const created = await createConn();
    expect(created.id).toBeTruthy();
    expect(created.hasCredentials).toBe(false);
    expect(created.authKind).toBe('none');
    expect(created.expectedEnv[0]).toBe('SN_TESTSNOW_TOKEN');

    const list = (await (await apiGet('/api/servicenow-connections')).json()) as SnConnectionWithStatus[];
    expect(list.some((c) => c.id === created.id)).toBe(true);

    // Credentials appear once the env var is set — and are never echoed back.
    process.env.SN_TESTSNOW_PASSWORD = 'hunter2';
    const withCreds = (await (await apiGet('/api/servicenow-connections')).json()) as SnConnectionWithStatus[];
    const mine = withCreds.find((c) => c.id === created.id);
    expect(mine?.hasCredentials).toBe(true);
    expect(mine?.authKind).toBe('basic');
    expect(JSON.stringify(mine)).not.toContain('hunter2');

    expect(await (await del(`/api/servicenow-connections/${created.id}`)).json()).toEqual({ deleted: true });
  });

  test('rejects a connection with no name', async () => {
    const res = await apiPost('/api/servicenow-connections', { ...CONN, name: '' });
    expect(res.status).toBe(400);
  });
});

describe('run gating', () => {
  test('412 without credentials, naming the env vars to set', async () => {
    const conn = await createConn();
    const res = await apiPost(`/api/servicenow-connections/${conn.id}/run`, {
      operation: 'table_read',
      table: 'incident',
    });
    expect(res.status).toBe(412);
    const body = (await res.json()) as SnRunResult;
    expect(body.ok).toBe(false);
    if (!body.ok) {
      expect(body.error?.code).toBe('no_credentials');
      expect(body.error?.message).toContain('SN_TESTSNOW_TOKEN');
    }
  });

  test('a table_write is blocked without allowWrites + SN_ALLOW_WRITES', async () => {
    const conn = await createConn();
    process.env.SN_TESTSNOW_TOKEN = 'tok';
    const res = await apiPost(`/api/servicenow-connections/${conn.id}/run`, {
      operation: 'table_write',
      table: 'incident',
      writeMode: 'create',
      body: { short_description: 'x' },
    });
    const body = (await res.json()) as SnRunResult;
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.error?.code).toBe('writes_blocked');
  });
});

describe('run against a fake ServiceNow', () => {
  let up: FakeUpstream;
  afterEach(async () => {
    await up?.stop();
  });

  test('table_read hits the Table API with auth + sysparm params', async () => {
    up = startFakeUpstream();
    up.handler = () =>
      new Response(JSON.stringify({ result: [{ number: 'INC001', state: '1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    // Point the client at the fake upstream + give it Basic creds, all via env.
    process.env.SN_TESTSNOW_URL = up.url;
    process.env.SN_TESTSNOW_PASSWORD = 'pw';
    const conn = await createConn();

    const res = await apiPost(`/api/servicenow-connections/${conn.id}/run`, {
      operation: 'table_read',
      table: 'incident',
      query: 'active=true',
      fields: ['number', 'state'],
      limit: 5,
    });
    const body = (await res.json()) as SnRunResult;
    expect(body.ok).toBe(true);
    expect(body.rowCount).toBe(1);
    expect(body.rows?.[0]).toEqual({ number: 'INC001', state: '1' });

    const recorded = up.requests.at(-1)!;
    expect(recorded.method).toBe('GET');
    expect(recorded.path).toBe('now/table/incident');
    expect(recorded.query.sysparm_query).toBe('active=true');
    expect(recorded.query.sysparm_fields).toBe('number,state');
    expect(recorded.headers.authorization).toBe(`Basic ${Buffer.from('reader:pw').toString('base64')}`);
  });
});

describe('servicenow-requests CRUD', () => {
  test('create → list → delete', async () => {
    const res = await apiPost('/api/servicenow-requests', {
      name: 'open incidents',
      connectionId: null,
      operation: 'table_read',
      spec: { table: 'incident', query: 'active=true' },
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as SnSavedRequest;
    expect(created.id).toBeTruthy();
    expect(created.spec.table).toBe('incident');

    const list = (await (await apiGet('/api/servicenow-requests')).json()) as SnSavedRequest[];
    expect(list.some((r) => r.id === created.id)).toBe(true);

    expect(await (await del(`/api/servicenow-requests/${created.id}`)).json()).toEqual({ deleted: true });
  });

  test('rejects an invalid operation', async () => {
    const res = await apiPost('/api/servicenow-requests', { name: 'x', operation: 'drop_table' });
    expect(res.status).toBe(400);
  });
});
