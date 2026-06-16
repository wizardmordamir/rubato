/**
 * Integration: the query-builder API through `route()` — connection + saved-query
 * CRUD, credential gating (412 without QB_* env), the read-only guard (write SQL
 * blocked before any driver loads), and the lazy-driver failure path (a SELECT
 * against postgres without `pg` installed fails that run with a clean message,
 * not a boot error).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { DbConnectionWithStatus, RunQueryResult, SavedDbQuery } from '../../shared/queryBuilder';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

const CONN = {
  name: 'prod pg',
  dialect: 'postgres' as const,
  host: 'db.example.com',
  port: 5432,
  database: 'app',
  username: 'reader',
  ssl: false,
  envKey: 'TESTPG',
  collections: ['users', 'orders'],
  allowWrites: false,
};

const createConn = async (): Promise<DbConnectionWithStatus> => {
  const res = await apiPost('/api/db-connections', CONN);
  expect(res.status).toBe(200);
  return (await res.json()) as DbConnectionWithStatus;
};

const del = (path: string) => fetchRoute(path, 'DELETE');
async function fetchRoute(path: string, method: string): Promise<Response> {
  const { route } = await import('../../server/router');
  return route(new Request(`http://localhost${path}`, { method }));
}

afterEach(() => {
  delete process.env.QB_TESTPG_PASSWORD;
});

describe('db-connections CRUD', () => {
  test('create → list (with credential status) → delete', async () => {
    const created = await createConn();
    expect(created.id).toBeTruthy();
    expect(created.hasCredentials).toBe(false);
    expect(created.expectedEnv).toEqual(['QB_TESTPG_PASSWORD', 'QB_TESTPG_URL']);

    const list = (await (await apiGet('/api/db-connections')).json()) as DbConnectionWithStatus[];
    expect(list.some((c) => c.id === created.id)).toBe(true);

    // Credentials appear once the env var is set — and are never echoed back.
    process.env.QB_TESTPG_PASSWORD = 'hunter2';
    const withCreds = (await (await apiGet('/api/db-connections')).json()) as DbConnectionWithStatus[];
    const mine = withCreds.find((c) => c.id === created.id);
    expect(mine?.hasCredentials).toBe(true);
    expect(JSON.stringify(mine)).not.toContain('hunter2');

    const deleted = await (await del(`/api/db-connections/${created.id}`)).json();
    expect(deleted).toEqual({ deleted: true });
  });

  test('rejects a bad dialect', async () => {
    const res = await apiPost('/api/db-connections', { ...CONN, dialect: 'sqlite3' });
    expect(res.status).toBe(400);
  });
});

describe('run gating', () => {
  test('412 without credentials, naming the env vars to set', async () => {
    const conn = await createConn();
    const res = await apiPost(`/api/db-connections/${conn.id}/run`, { query: 'SELECT 1' });
    expect(res.status).toBe(412);
    const body = (await res.json()) as RunQueryResult;
    expect(body.ok).toBe(false);
    if (!body.ok) {
      expect(body.error.code).toBe('no_credentials');
      expect(body.error.message).toContain('QB_TESTPG_PASSWORD');
    }
  });

  test('write SQL is blocked by the read-only guard before any driver loads', async () => {
    const conn = await createConn();
    process.env.QB_TESTPG_PASSWORD = 'hunter2';
    const res = await apiPost(`/api/db-connections/${conn.id}/run`, { query: 'DELETE FROM users' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunQueryResult;
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.error.code).toBe('writes_blocked');
  });

  test('a missing driver fails the run with a clean message (lazy load)', async () => {
    const conn = await createConn();
    process.env.QB_TESTPG_PASSWORD = 'hunter2';
    const res = await apiPost(`/api/db-connections/${conn.id}/run`, { query: 'SELECT 1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunQueryResult;
    // pg isn't installed in the test env — the run (not the server) fails, naming the driver.
    expect(body.ok).toBe(false);
    if (!body.ok) {
      expect(body.error.code).toBe('query_failed');
      expect(body.error.message).toContain('pg');
    }
  });

  test('mongo runs require a collection', async () => {
    const res0 = await apiPost('/api/db-connections', { ...CONN, name: 'mongo', dialect: 'mongodb', envKey: 'TESTPG' });
    const conn = (await res0.json()) as DbConnectionWithStatus;
    process.env.QB_TESTPG_PASSWORD = 'hunter2';
    const res = await apiPost(`/api/db-connections/${conn.id}/run`, { filter: {} });
    expect(res.status).toBe(400);
  });
});

describe('saved queries CRUD', () => {
  test('create → list → update → delete round-trips the builder spec', async () => {
    const create = await apiPost('/api/db-queries', {
      name: 'active users',
      connectionId: null,
      dialect: 'postgres',
      kind: 'sql',
      collection: 'users',
      spec: { table: 'users', where: [{ column: 'active', op: '=', value: 'true' }] },
      queryText: 'SELECT * FROM users WHERE active = true',
    });
    expect(create.status).toBe(200);
    const saved = (await create.json()) as SavedDbQuery;
    expect(saved.id).toBeTruthy();

    const list = (await (await apiGet('/api/db-queries')).json()) as SavedDbQuery[];
    const mine = list.find((q) => q.id === saved.id);
    expect((mine?.spec as { table: string }).table).toBe('users');

    const update = await apiPost('/api/db-queries', { ...saved, name: 'renamed' });
    expect(((await update.json()) as SavedDbQuery).name).toBe('renamed');

    const deleted = await (await del(`/api/db-queries/${saved.id}`)).json();
    expect(deleted).toEqual({ deleted: true });
  });

  test('rejects a nameless save', async () => {
    const res = await apiPost('/api/db-queries', { kind: 'sql', queryText: 'SELECT 1' });
    expect(res.status).toBe(400);
  });
});
