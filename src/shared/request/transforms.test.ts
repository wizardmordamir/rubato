/**
 * Tests for the pure request transforms: curl/fetch generation, {{var}}
 * interpolation, and the portable share-file round-trip.
 */

import { describe, expect, test } from 'bun:test';
import { emptyRequest, type HttpRequest } from './model';
import { buildCurl, buildFetch, interpolate, parseRequestFile, toRequestFile } from './transforms';

const kv = (key: string, value: string, enabled = true) => ({ key, value, enabled });

describe('buildCurl', () => {
  test('GET with query params and headers', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      method: 'GET',
      url: 'https://api.example.com/users',
      query: [kv('page', '2'), kv('q', 'a b'), kv('skip', 'x', false)],
      headers: [kv('Accept', 'application/json')],
    };
    const out = buildCurl(req);
    expect(out).not.toContain('-X');
    expect(out).toContain('https://api.example.com/users?page=2&q=a%20b');
    expect(out).not.toContain('skip=');
    expect(out).toContain("-H 'Accept: application/json'");
  });

  test('preserves an existing query string', () => {
    const req: HttpRequest = { ...emptyRequest(), url: 'https://x.test/a?one=1', query: [kv('two', '2')] };
    expect(buildCurl(req)).toContain('https://x.test/a?one=1&two=2');
  });

  test('POST json adds method, content-type, and data', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      method: 'POST',
      url: 'https://x.test/p',
      body: { type: 'json', text: '{"a":1}' },
    };
    const out = buildCurl(req);
    expect(out).toContain('-X POST');
    expect(out).toContain("-H 'Content-Type: application/json'");
    expect(out).toContain(`--data '{"a":1}'`);
  });

  test('does not duplicate content-type the user already set', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      method: 'POST',
      url: 'https://x.test/p',
      headers: [kv('Content-Type', 'application/json')],
      body: { type: 'json', text: '{}' },
    };
    const out = buildCurl(req);
    const matches = out.match(/Content-Type: application\/json/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test('basic auth uses -u', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      url: 'https://x.test',
      auth: { type: 'basic', username: 'user', password: 'pass' },
    };
    expect(buildCurl(req)).toContain("-u 'user:pass'");
  });

  test('bearer auth adds an Authorization header', () => {
    const req: HttpRequest = { ...emptyRequest(), url: 'https://x.test', auth: { type: 'bearer', token: 'abc123' } };
    expect(buildCurl(req)).toContain("-H 'Authorization: Bearer abc123'");
  });

  test('apiKey in header adds the named header', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      url: 'https://x.test',
      auth: { type: 'apiKey', key: 'X-Api-Key', value: 'secret', in: 'header' },
    };
    expect(buildCurl(req)).toContain("-H 'X-Api-Key: secret'");
  });

  test('apiKey in query appends to the url', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      url: 'https://x.test/r',
      auth: { type: 'apiKey', key: 'api_key', value: 'k v', in: 'query' },
    };
    expect(buildCurl(req)).toContain('https://x.test/r?api_key=k%20v');
  });

  test('form body emits urlencoded --data per field', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      method: 'POST',
      url: 'https://x.test',
      body: { type: 'form', fields: [kv('name', 'a b'), kv('city', 'NY'), kv('off', 'x', false)] },
    };
    const out = buildCurl(req);
    expect(out).toContain("--data 'name=a%20b'");
    expect(out).toContain("--data 'city=NY'");
    expect(out).not.toContain('off=');
  });

  test('multipart with a file uses -F with @filename', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      method: 'POST',
      url: 'https://x.test',
      body: {
        type: 'multipart',
        fields: [
          { kind: 'text', key: 'title', value: 'hi', enabled: true },
          { kind: 'file', key: 'doc', filename: 'report.pdf', contentBase64: 'AAA', enabled: true },
        ],
      },
    };
    const out = buildCurl(req);
    expect(out).toContain("-F 'title=hi'");
    expect(out).toContain("-F 'doc=@report.pdf'");
  });
});

describe('buildFetch', () => {
  test('json body uses JSON.stringify and content-type header', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      method: 'POST',
      url: 'https://x.test/p',
      body: { type: 'json', text: '{"a":1}' },
    };
    const out = buildFetch(req);
    expect(out).toContain("method: 'POST'");
    expect(out).toContain("'Content-Type': 'application/json'");
    expect(out).toContain('body: JSON.stringify({');
    expect(out).toContain('.then((res) => res.json())');
  });

  test('basic auth uses btoa()', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      url: 'https://x.test',
      auth: { type: 'basic', username: 'u', password: 'p' },
    };
    expect(buildFetch(req)).toContain("'Basic ' + btoa('u:p')");
  });

  test('form body uses URLSearchParams', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      method: 'POST',
      url: 'https://x.test',
      body: { type: 'form', fields: [kv('a', '1'), kv('b', '2')] },
    };
    const out = buildFetch(req);
    expect(out).toContain('body: new URLSearchParams({');
    expect(out).toContain("'a': '1'");
    expect(out).toContain("'b': '2'");
  });

  test('multipart builds a FormData with append lines', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      method: 'POST',
      url: 'https://x.test',
      body: {
        type: 'multipart',
        fields: [
          { kind: 'text', key: 'title', value: 'hi', enabled: true },
          { kind: 'file', key: 'doc', filename: 'f.pdf', contentBase64: 'AAA', enabled: true },
        ],
      },
    };
    const out = buildFetch(req);
    expect(out).toContain('const formData = new FormData();');
    expect(out).toContain("formData.append('title', 'hi');");
    expect(out).toContain('f.pdf');
    expect(out).toContain('body: formData,');
  });
});

describe('interpolate', () => {
  test('replaces known vars in url, header, and body; leaves unknown untouched', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      method: 'POST',
      url: '{{base}}/v1/items?missing={{nope}}',
      headers: [kv('Authorization', 'Bearer {{token}}')],
      body: { type: 'json', text: '{"host":"{{base}}"}' },
    };
    const out = interpolate(req, { base: 'https://api.example.com', token: 'secret' });
    expect(out.url).toBe('https://api.example.com/v1/items?missing={{nope}}');
    expect(out.headers[0].value).toBe('Bearer secret');
    expect(out.body).toEqual({ type: 'json', text: '{"host":"https://api.example.com"}' });
  });

  test('is pure — does not mutate the input', () => {
    const req: HttpRequest = { ...emptyRequest(), url: '{{base}}/x' };
    const snapshot = JSON.parse(JSON.stringify(req));
    interpolate(req, { base: 'https://h' });
    expect(req).toEqual(snapshot);
  });

  test('substitutes auth and form fields but not file filenames', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      url: '{{base}}',
      auth: { type: 'bearer', token: '{{token}}' },
      body: {
        type: 'multipart',
        fields: [
          { kind: 'text', key: '{{k}}', value: '{{token}}', enabled: true },
          { kind: 'file', key: 'doc', filename: '{{base}}.pdf', contentBase64: 'AAA', enabled: true },
        ],
      },
    };
    const out = interpolate(req, { base: 'https://h', token: 't', k: 'name' });
    expect(out.auth).toEqual({ type: 'bearer', token: 't' });
    if (out.body.type === 'multipart') {
      const text = out.body.fields[0];
      const file = out.body.fields[1];
      expect(text).toEqual({ kind: 'text', key: 'name', value: 't', enabled: true });
      // file filename is left untouched
      if (file.kind === 'file') expect(file.filename).toBe('{{base}}.pdf');
    }
  });
});

describe('toRequestFile / parseRequestFile', () => {
  test('round-trips a request', () => {
    const req: HttpRequest = {
      ...emptyRequest(),
      method: 'POST',
      url: 'https://x.test',
      headers: [kv('Accept', 'application/json')],
      body: { type: 'json', text: '{}' },
    };
    const file = toRequestFile(req, 'My Request');
    expect(file.kind).toBe('rubato.request');
    expect(file.version).toBe(1);
    expect(file.name).toBe('My Request');
    expect(parseRequestFile(file)).toEqual(req);
  });

  test('normalizes missing optional arrays to []', () => {
    const data = { kind: 'rubato.request', version: 1, request: { method: 'GET', url: 'https://x' } };
    const out = parseRequestFile(data);
    expect(out.query).toEqual([]);
    expect(out.headers).toEqual([]);
    expect(out.auth).toEqual({ type: 'none' });
    expect(out.body).toEqual({ type: 'none' });
  });

  test('throws on a non-request file', () => {
    expect(() => parseRequestFile({ kind: 'something-else', request: {} })).toThrow('not a rubato request file');
    expect(() => parseRequestFile({ kind: 'rubato.request', request: 'nope' })).toThrow();
    expect(() => parseRequestFile(null)).toThrow();
  });
});
