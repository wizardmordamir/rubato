import { beforeEach, describe, expect, test } from 'bun:test';
import { __resetDbForTests } from './db';
import { route } from './router';

// Exercise the full dispatch + db + crypto stack through the router. The test
// preload (src/test/setup.ts) isolates RUBATO_HOME, so the server vault secret is
// auto-generated into a throwaway ~/.rubato/.env and item encryption is real.

const get = (path: string, headers?: Record<string, string>) => route(new Request(`http://x${path}`, { headers }));

const send = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  route(
    new Request(`http://x${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const MASTER = 'correct horse battery';

// Set the master password (first time) and return the unlock token.
async function setupMasterAndUnlock(): Promise<string> {
  const res = await send('POST', '/api/vault/master', { masterPassword: MASTER });
  expect(res.status).toBe(201);
  return (await res.json()).token as string;
}

describe('vault routes', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  test('status reports no master + zero items initially', async () => {
    const res = await get('/api/vault/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasMaster: false, itemCount: 0 });
  });

  test('setting the master the first time returns a token; a second set is 409', async () => {
    const first = await send('POST', '/api/vault/master', { masterPassword: MASTER });
    expect(first.status).toBe(201);
    expect(typeof (await first.json()).token).toBe('string');

    expect((await get('/api/vault/status')).status).toBe(200);
    expect((await (await get('/api/vault/status')).json()).hasMaster).toBe(true);

    const again = await send('POST', '/api/vault/master', { masterPassword: 'another-one' });
    expect(again.status).toBe(409);
  });

  test('a too-short master password is rejected', async () => {
    const res = await send('POST', '/api/vault/master', { masterPassword: 'short' });
    expect(res.status).toBe(400);
  });

  test('unlock: wrong password is 401, correct password returns a token', async () => {
    await setupMasterAndUnlock();
    expect((await send('POST', '/api/vault/unlock', { masterPassword: 'nope' })).status).toBe(401);

    const ok = await send('POST', '/api/vault/unlock', { masterPassword: MASTER });
    expect(ok.status).toBe(200);
    expect(typeof (await ok.json()).token).toBe('string');
  });

  test('items require a valid unlock token', async () => {
    const token = await setupMasterAndUnlock();

    // No token → locked.
    expect((await get('/api/vault/items')).status).toBe(401);
    // Garbage token → locked (decrypt fails → not unlocked).
    expect((await get('/api/vault/items', { 'x-vault-token': 'garbage' })).status).toBe(401);
    // Valid token → ok.
    const ok = await get('/api/vault/items', { 'x-vault-token': token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([]);
  });

  test('create → list round-trips encrypted fields (including secrets)', async () => {
    const token = await setupMasterAndUnlock();
    const input = {
      title: 'Chase',
      link: 'https://chase.com',
      username: 'me@example.com',
      password: 'hunter2',
      description: 'bank',
      notes: 'line1\nline2',
      fields: [
        { label: 'PIN', value: '1234', secret: true },
        { label: 'Branch', value: 'Main St' },
      ],
    };
    const created = await send('POST', '/api/vault/items', input, { 'x-vault-token': token });
    expect(created.status).toBe(201);
    const item = await created.json();
    expect(item.id).toBeTruthy();
    expect(item.title).toBe('Chase');
    expect(item.password).toBe('hunter2');

    const listed = await (await get('/api/vault/items', { 'x-vault-token': token })).json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      title: 'Chase',
      username: 'me@example.com',
      password: 'hunter2',
      fields: [
        { label: 'PIN', value: '1234', secret: true },
        { label: 'Branch', value: 'Main St', secret: false },
      ],
    });

    // status item count reflects the new item.
    expect((await (await get('/api/vault/status')).json()).itemCount).toBe(1);
  });

  test('creating an item without a title is a 400', async () => {
    const token = await setupMasterAndUnlock();
    const res = await send('POST', '/api/vault/items', { username: 'x' }, { 'x-vault-token': token });
    expect(res.status).toBe(400);
  });

  test('the encrypted blob at rest is not plaintext', async () => {
    const { getDb } = await import('./db');
    const token = await setupMasterAndUnlock();
    await send('POST', '/api/vault/items', { title: 'Secret', password: 'p4ssw0rd-zzz' }, { 'x-vault-token': token });
    const row = getDb().query<{ data: string }, []>('SELECT data FROM vault_items LIMIT 1').get();
    expect(row?.data).toBeTruthy();
    expect(row?.data).not.toContain('p4ssw0rd-zzz');
    expect(row?.data).not.toContain('Secret');
  });

  test('update replaces an item; a missing id is 404', async () => {
    const token = await setupMasterAndUnlock();
    const created = await (
      await send('POST', '/api/vault/items', { title: 'Old', password: 'a' }, { 'x-vault-token': token })
    ).json();

    const updated = await send(
      'PATCH',
      `/api/vault/items/${created.id}`,
      { title: 'New', password: 'b' },
      { 'x-vault-token': token },
    );
    expect(updated.status).toBe(200);
    expect((await updated.json()).title).toBe('New');

    const listed = await (await get('/api/vault/items', { 'x-vault-token': token })).json();
    expect(listed[0].title).toBe('New');
    expect(listed[0].password).toBe('b');

    expect((await send('PATCH', '/api/vault/items/nope', { title: 'x' }, { 'x-vault-token': token })).status).toBe(404);
  });

  test('delete removes an item; deleting a missing id is 404', async () => {
    const token = await setupMasterAndUnlock();
    const created = await (
      await send('POST', '/api/vault/items', { title: 'Doomed' }, { 'x-vault-token': token })
    ).json();

    expect((await send('DELETE', `/api/vault/items/${created.id}`)).status).toBe(200);
    expect(await (await get('/api/vault/items', { 'x-vault-token': token })).json()).toHaveLength(0);
    expect((await send('DELETE', `/api/vault/items/${created.id}`)).status).toBe(404);
  });

  test('change master: wrong current is 401; after change the new password unlocks', async () => {
    await setupMasterAndUnlock();

    expect(
      (await send('POST', '/api/vault/master/change', { currentPassword: 'wrong', newPassword: 'a-new-password' }))
        .status,
    ).toBe(401);

    const changed = await send('POST', '/api/vault/master/change', {
      currentPassword: MASTER,
      newPassword: 'a-new-password',
    });
    expect(changed.status).toBe(200);

    // Old password no longer works; new one does.
    expect((await send('POST', '/api/vault/unlock', { masterPassword: MASTER })).status).toBe(401);
    expect((await send('POST', '/api/vault/unlock', { masterPassword: 'a-new-password' })).status).toBe(200);
  });

  test('changing the master does NOT lose items (server-key encryption)', async () => {
    const token = await setupMasterAndUnlock();
    await send('POST', '/api/vault/items', { title: 'Keeper', password: 'keep' }, { 'x-vault-token': token });

    await send('POST', '/api/vault/master/change', { currentPassword: MASTER, newPassword: 'a-new-password' });
    const newToken = (await (await send('POST', '/api/vault/unlock', { masterPassword: 'a-new-password' })).json())
      .token as string;

    const listed = await (await get('/api/vault/items', { 'x-vault-token': newToken })).json();
    expect(listed).toHaveLength(1);
    expect(listed[0].password).toBe('keep');
  });

  test('method guards: wrong verbs are 405', async () => {
    expect((await send('POST', '/api/vault/status')).status).toBe(405);
    expect((await get('/api/vault/master')).status).toBe(405);
    expect((await get('/api/vault/unlock')).status).toBe(405);
  });
});
