/**
 * Unit tests for the server-side HTTP executor (`runHttpRequest`). The only
 * export, so its private URL/header/body builders are exercised through it by
 * stubbing `globalThis.fetch` and inspecting the outgoing `(url, init)` plus the
 * parsed `HttpResult`. No network — the stub is restored in afterAll so it never
 * leaks into the integration suites that share the process.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { emptyRequest, type HttpRequest } from '../shared/request/model';
import { runHttpRequest } from './requestRunner';

// What the stub captured on the last call, and what it should reply with.
let lastCall: { url: string; init: RequestInit } | undefined;
let responder: (url: string, init: RequestInit) => Response;

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    lastCall = { url, init: init ?? {} };
    return responder(url, init ?? {});
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  lastCall = undefined;
  // Default: a tiny 200 text response; individual tests override as needed.
  responder = () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
});

const makeReq = (over: Partial<HttpRequest>): HttpRequest => ({ ...emptyRequest(), ...over });
/** Read the captured outgoing headers as a fresh Headers (case-insensitive). */
const sentHeaders = (): Headers => new Headers(lastCall?.init.headers);

describe('runHttpRequest — URL building', () => {
  test('leaves the url untouched when there are no enabled query params', async () => {
    await runHttpRequest(makeReq({ url: 'https://api.example.com/things' }));
    expect(lastCall?.url).toBe('https://api.example.com/things');
  });

  test('appends enabled query params, url-encoding keys and values', async () => {
    await runHttpRequest(
      makeReq({
        url: 'https://api.example.com/s',
        query: [
          { key: 'q', value: 'a b&c', enabled: true },
          { key: 'page', value: '2', enabled: true },
        ],
      }),
    );
    expect(lastCall?.url).toBe('https://api.example.com/s?q=a%20b%26c&page=2');
  });

  test('skips disabled and blank-key query rows', async () => {
    await runHttpRequest(
      makeReq({
        url: 'https://api.example.com/s',
        query: [
          { key: 'keep', value: '1', enabled: true },
          { key: 'drop', value: '2', enabled: false },
          { key: '', value: '3', enabled: true },
        ],
      }),
    );
    expect(lastCall?.url).toBe('https://api.example.com/s?keep=1');
  });

  test('joins with & when the url already has a query string', async () => {
    await runHttpRequest(
      makeReq({ url: 'https://api.example.com/s?existing=1', query: [{ key: 'q', value: 'x', enabled: true }] }),
    );
    expect(lastCall?.url).toBe('https://api.example.com/s?existing=1&q=x');
  });

  test('apiKey-in-query appends the key/value to the url (not a header)', async () => {
    await runHttpRequest(
      makeReq({
        url: 'https://api.example.com/s',
        auth: { type: 'apiKey', key: 'api_key', value: 'secret 1', in: 'query' },
      }),
    );
    expect(lastCall?.url).toBe('https://api.example.com/s?api_key=secret%201');
    expect(sentHeaders().has('api_key')).toBe(false);
  });
});

describe('runHttpRequest — headers & auth', () => {
  test('sends enabled header rows', async () => {
    await runHttpRequest(
      makeReq({
        url: 'https://x',
        headers: [
          { key: 'Accept', value: 'application/json', enabled: true },
          { key: 'X-Skip', value: 'no', enabled: false },
        ],
      }),
    );
    expect(sentHeaders().get('accept')).toBe('application/json');
    expect(sentHeaders().has('x-skip')).toBe(false);
  });

  test('basic auth becomes Authorization: Basic base64(user:pass)', async () => {
    await runHttpRequest(makeReq({ url: 'https://x', auth: { type: 'basic', username: 'alice', password: 'p@ss' } }));
    expect(sentHeaders().get('authorization')).toBe(`Basic ${btoa('alice:p@ss')}`);
  });

  test('bearer auth becomes Authorization: Bearer <token>', async () => {
    await runHttpRequest(makeReq({ url: 'https://x', auth: { type: 'bearer', token: 'tok123' } }));
    expect(sentHeaders().get('authorization')).toBe('Bearer tok123');
  });

  test('apiKey-in-header sets the named header', async () => {
    await runHttpRequest(
      makeReq({ url: 'https://x', auth: { type: 'apiKey', key: 'X-Api-Key', value: 'abc', in: 'header' } }),
    );
    expect(sentHeaders().get('x-api-key')).toBe('abc');
  });

  test('empty basic credentials add no Authorization header', async () => {
    await runHttpRequest(makeReq({ url: 'https://x', auth: { type: 'basic', username: '', password: '' } }));
    expect(sentHeaders().has('authorization')).toBe(false);
  });
});

describe('runHttpRequest — body building', () => {
  test('GET never sends a body even if one is configured', async () => {
    await runHttpRequest(makeReq({ method: 'GET', url: 'https://x', body: { type: 'json', text: '{"a":1}' } }));
    expect(lastCall?.init.body).toBeUndefined();
    expect(sentHeaders().has('content-type')).toBe(false);
  });

  test('HEAD never sends a body', async () => {
    await runHttpRequest(
      makeReq({ method: 'HEAD', url: 'https://x', body: { type: 'raw', text: 'hi', contentType: 'text/plain' } }),
    );
    expect(lastCall?.init.body).toBeUndefined();
  });

  test('json body sets the text and a default Content-Type', async () => {
    await runHttpRequest(makeReq({ method: 'POST', url: 'https://x', body: { type: 'json', text: '{"a":1}' } }));
    expect(lastCall?.init.body).toBe('{"a":1}');
    expect(sentHeaders().get('content-type')).toBe('application/json');
  });

  test('json body does not override a Content-Type the user already set', async () => {
    await runHttpRequest(
      makeReq({
        method: 'POST',
        url: 'https://x',
        headers: [{ key: 'Content-Type', value: 'application/vnd.api+json', enabled: true }],
        body: { type: 'json', text: '{"a":1}' },
      }),
    );
    expect(sentHeaders().get('content-type')).toBe('application/vnd.api+json');
  });

  test('raw body sets its own Content-Type', async () => {
    await runHttpRequest(
      makeReq({
        method: 'POST',
        url: 'https://x',
        body: { type: 'raw', text: '<x/>', contentType: 'application/xml' },
      }),
    );
    expect(lastCall?.init.body).toBe('<x/>');
    expect(sentHeaders().get('content-type')).toBe('application/xml');
  });

  test('form body sends URLSearchParams of the enabled fields', async () => {
    await runHttpRequest(
      makeReq({
        method: 'POST',
        url: 'https://x',
        body: {
          type: 'form',
          fields: [
            { key: 'a', value: '1', enabled: true },
            { key: 'b', value: '2', enabled: false },
          ],
        },
      }),
    );
    const body = lastCall?.init.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('a')).toBe('1');
    expect((body as URLSearchParams).has('b')).toBe(false);
  });

  test('multipart body sends FormData and drops content-type so fetch sets the boundary', async () => {
    await runHttpRequest(
      makeReq({
        method: 'POST',
        url: 'https://x',
        headers: [{ key: 'Content-Type', value: 'multipart/form-data', enabled: true }],
        body: {
          type: 'multipart',
          fields: [
            { kind: 'text', key: 'note', value: 'hello', enabled: true },
            {
              kind: 'file',
              key: 'f',
              filename: 'a.txt',
              contentBase64: btoa('hi'),
              contentType: 'text/plain',
              enabled: true,
            },
          ],
        },
      }),
    );
    const body = lastCall?.init.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('note')).toBe('hello');
    expect((body as FormData).get('f')).toBeInstanceOf(Blob);
    // The runner deletes content-type so fetch can set the multipart boundary itself.
    expect(sentHeaders().has('content-type')).toBe(false);
  });
});

describe('runHttpRequest — response parsing', () => {
  test('maps status, ok, headers, body, contentType, and a non-negative duration', async () => {
    responder = () =>
      new Response('{"ok":true}', {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
      });
    const result = await runHttpRequest(makeReq({ url: 'https://x' }));
    expect(result.status).toBe(201);
    expect(result.statusText).toBe('Created');
    expect(result.ok).toBe(true);
    expect(result.body).toBe('{"ok":true}');
    expect(result.contentType).toBe('application/json');
    expect(result.headers).toContainEqual(['x-trace', 'abc']);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('ok is false for a 4xx/5xx status', async () => {
    responder = () => new Response('nope', { status: 500, statusText: 'Server Error' });
    const result = await runHttpRequest(makeReq({ url: 'https://x' }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });

  test('sizeBytes is the UTF-8 byte length, not the character count', async () => {
    responder = () => new Response('€', { status: 200 }); // 3 bytes, 1 char
    const result = await runHttpRequest(makeReq({ url: 'https://x' }));
    expect(result.body).toBe('€');
    expect(result.sizeBytes).toBe(3);
  });

  test('truncates a body larger than the 25MB cap', async () => {
    const MAX = 25 * 1024 * 1024;
    responder = () => new Response('a'.repeat(MAX + 50), { status: 200 });
    const result = await runHttpRequest(makeReq({ url: 'https://x' }));
    expect(result.body.endsWith('…[response truncated]')).toBe(true);
    expect(result.body.length).toBe(MAX + '\n…[response truncated]'.length);
  });

  test('a body that fails to read degrades to an empty string (status still mapped)', async () => {
    responder = () =>
      ({
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain' }),
        arrayBuffer: () => Promise.reject(new Error('stream error')),
      }) as unknown as Response;
    const result = await runHttpRequest(makeReq({ url: 'https://x' }));
    expect(result.status).toBe(200);
    expect(result.body).toBe('');
    expect(result.sizeBytes).toBe(0);
  });
});

describe('runHttpRequest — failure handling', () => {
  test('a thrown Error becomes a status-0 Network Error result', async () => {
    responder = () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await runHttpRequest(makeReq({ url: 'https://x' }));
    expect(result.status).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.statusText).toBe('Network Error');
    expect(result.error).toBe('ECONNREFUSED');
    expect(result.body).toBe('');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('a TimeoutError is reported as a timeout with the configured budget', async () => {
    responder = () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    };
    const result = await runHttpRequest(makeReq({ url: 'https://x' }));
    expect(result.status).toBe(0);
    expect(result.statusText).toBe('Timeout');
    expect(result.error).toBe('request timed out after 30000ms');
  });

  test('a non-Error throw falls back to a generic message', async () => {
    responder = () => {
      throw 'kaboom';
    };
    const result = await runHttpRequest(makeReq({ url: 'https://x' }));
    expect(result.status).toBe(0);
    expect(result.statusText).toBe('Network Error');
    expect(result.error).toBe('fetch failed');
  });
});
