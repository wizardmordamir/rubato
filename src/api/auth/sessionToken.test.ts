import { describe, expect, test } from 'bun:test';
import type { CallbackDoc } from 'cwip';
import { performSessionLogin } from './sessionToken';

// ── fixtures ─────────────────────────────────────────────────────────────────
const sessionSelectDoc = (): CallbackDoc => ({
  authId: 'a1',
  callbacks: [
    { type: 'TextOutputCallback', output: [{ name: 'message', value: 'pick a session' }] },
    { type: 'ConfirmationCallback', input: [{ name: 'IDToken1', value: 0 }] },
  ],
});
const credsDoc = (): CallbackDoc => ({
  authId: 'a2',
  callbacks: [
    { type: 'NameCallback', input: [{ name: 'IDToken1', value: '' }] },
    { type: 'PasswordCallback', input: [{ name: 'IDToken2', value: '' }] },
  ],
});

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const makeJwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`;
const asSessionField = (jwt: string) => Buffer.from(jwt).toString('base64');

/** A fake IdP: returns the scripted POST docs in order, then `getDoc` for the GET. */
function makeIdp(postDocs: CallbackDoc[], getDoc: unknown, cookie = 'session=abc') {
  const calls = {
    posts: [] as Array<{ url: string; body: CallbackDoc | undefined; cookie: string | null }>,
    gets: [] as Array<{ url: string; cookie: string | null }>,
  };
  let pi = 0;
  const respond = (obj: unknown, setCookie?: string) => {
    const res = new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });
    if (setCookie) (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie = () => [setCookie];
    return res;
  };
  const fn = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if ((init.method ?? 'GET') === 'POST') {
      calls.posts.push({
        url,
        body: init.body ? (JSON.parse(String(init.body)) as CallbackDoc) : undefined,
        cookie: headers.get('cookie'),
      });
      return respond(postDocs[pi++] ?? {}, cookie);
    }
    calls.gets.push({ url, cookie: headers.get('cookie') });
    return respond(getDoc);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const config = { authUrl: 'https://idp/authenticate', tokenUrl: 'https://app/api/settings' };
const creds = { username: 'alice', password: 'hunter2' };

describe('performSessionLogin', () => {
  test('runs session-select → credentials → token exchange and decodes the JWT', async () => {
    const jwt = makeJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const { fn, calls } = makeIdp([sessionSelectDoc(), credsDoc(), { tokenId: 'sess-1' }], {
      data: { session: asSessionField(jwt) },
    });

    const result = await performSessionLogin({ config, creds, fetchImpl: fn });

    expect(result.token).toBe(jwt);
    expect(result.claims?.sub).toBe('u1');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.cookieHeader).toBe('session=abc');

    // 3 POSTs: opening (no body), session pick (choice 1), credentials
    expect(calls.posts).toHaveLength(3);
    expect(calls.posts[0].body).toBeUndefined();
    expect(calls.posts[1].body?.callbacks?.[1].input?.[0].value).toBe(1);
    expect(calls.posts[2].body?.callbacks?.[0].input?.[0].value).toBe('alice');
    expect(calls.posts[2].body?.callbacks?.[1].input?.[0].value).toBe('hunter2');
    // the session cookie from login is carried into the token GET
    expect(calls.gets[0].cookie).toBe('session=abc');
  });

  test('skipSessionSelection goes straight to credentials (one fewer round)', async () => {
    const jwt = makeJwt({ sub: 'u2' });
    const { fn, calls } = makeIdp([credsDoc(), { tokenId: 's' }], { data: { session: asSessionField(jwt) } });

    const result = await performSessionLogin({
      config: { ...config, skipSessionSelection: true },
      creds,
      fetchImpl: fn,
    });

    expect(result.token).toBe(jwt);
    expect(calls.posts).toHaveLength(2);
    expect(calls.posts[1].body?.callbacks?.[0].input?.[0].value).toBe('alice');
  });

  test('honors a custom sessionPath for the token field', async () => {
    const jwt = makeJwt({ sub: 'u3' });
    const { fn } = makeIdp([credsDoc(), {}], { token: { value: asSessionField(jwt) } });
    const result = await performSessionLogin({
      config: { ...config, skipSessionSelection: true, sessionPath: 'token.value' },
      creds,
      fetchImpl: fn,
    });
    expect(result.token).toBe(jwt);
  });

  test('throws when the token endpoint has no value at the session path', async () => {
    const { fn } = makeIdp([credsDoc(), {}], { data: {} });
    await expect(
      performSessionLogin({ config: { ...config, skipSessionSelection: true }, creds, fetchImpl: fn }),
    ).rejects.toThrow(/no session token/);
  });

  test('throws a clear error when not configured', async () => {
    await expect(performSessionLogin({ config: { authUrl: 'https://idp/x' }, creds })).rejects.toThrow(
      /not configured/,
    );
  });
});
