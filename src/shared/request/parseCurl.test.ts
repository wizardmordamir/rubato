/**
 * Tests for {@link parseCurl} — the forgiving curl-command → HttpRequest parser.
 * Covers the common shapes pasted from devtools/docs: bare URLs, headers, methods,
 * basic/bearer auth, json/form/multipart bodies, line-continued commands, and
 * URLs carrying a query string.
 */

import { describe, expect, test } from 'bun:test';
import { parseCurl } from './parseCurl';

describe('parseCurl', () => {
  test('simple bare URL defaults to GET', () => {
    const req = parseCurl('curl https://api.example.com/x');
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.example.com/x');
    expect(req.query).toEqual([]);
    expect(req.headers).toEqual([]);
    expect(req.auth).toEqual({ type: 'none' });
    expect(req.body).toEqual({ type: 'none' });
  });

  test('two -H headers become enabled header rows', () => {
    const req = parseCurl("curl https://api.example.com/x -H 'Accept: application/json' -H 'X-Trace: abc'");
    expect(req.method).toBe('GET');
    expect(req.headers).toEqual([
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Trace', value: 'abc', enabled: true },
    ]);
  });

  test('-X POST with content-type header and json --data', () => {
    const req = parseCurl(
      `curl -X POST https://api.example.com/x -H 'Content-Type: application/json' --data '{"a":1}'`,
    );
    expect(req.method).toBe('POST');
    expect(req.headers).toEqual([{ key: 'Content-Type', value: 'application/json', enabled: true }]);
    expect(req.body).toEqual({ type: 'json', text: '{"a":1}' });
  });

  test('-u user:pass becomes basic auth', () => {
    const req = parseCurl('curl https://api.example.com/x -u user:pass');
    expect(req.auth).toEqual({ type: 'basic', username: 'user', password: 'pass' });
  });

  test('Authorization: Bearer header becomes bearer auth and is dropped', () => {
    const req = parseCurl("curl https://api.example.com/x -H 'Authorization: Bearer tok'");
    expect(req.auth).toEqual({ type: 'bearer', token: 'tok' });
    expect(req.headers).toEqual([]);
  });

  test('non-bearer Authorization header is kept as a header', () => {
    const req = parseCurl("curl https://api.example.com/x -H 'Authorization: Custom xyz'");
    expect(req.auth).toEqual({ type: 'none' });
    expect(req.headers).toEqual([{ key: 'Authorization', value: 'Custom xyz', enabled: true }]);
  });

  test('form-style --data becomes form fields', () => {
    const req = parseCurl("curl https://api.example.com/x --data 'a=1&b=2'");
    expect(req.method).toBe('POST');
    expect(req.body).toEqual({
      type: 'form',
      fields: [
        { key: 'a', value: '1', enabled: true },
        { key: 'b', value: '2', enabled: true },
      ],
    });
  });

  test('multipart -F text and file fields', () => {
    const req = parseCurl("curl https://api.example.com/upload -F 'f=@photo.png' -F 'name=joe'");
    expect(req.method).toBe('POST');
    expect(req.body).toEqual({
      type: 'multipart',
      fields: [
        { kind: 'file', key: 'f', filename: 'photo.png', contentBase64: '', enabled: true },
        { kind: 'text', key: 'name', value: 'joe', enabled: true },
      ],
    });
  });

  test('multi-line curl with trailing backslashes', () => {
    const curl = `curl https://api.example.com/x \\
      -X POST \\
      -H 'Content-Type: application/json' \\
      --data '{"a":1}'`;
    const req = parseCurl(curl);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/x');
    expect(req.headers).toEqual([{ key: 'Content-Type', value: 'application/json', enabled: true }]);
    expect(req.body).toEqual({ type: 'json', text: '{"a":1}' });
  });

  test('existing query string is extracted into query rows', () => {
    const req = parseCurl("curl 'https://api.example.com/x?q=1&r=2'");
    expect(req.url).toBe('https://api.example.com/x');
    expect(req.query).toEqual([
      { key: 'q', value: '1', enabled: true },
      { key: 'r', value: '2', enabled: true },
    ]);
  });

  test('--url flag supplies the URL', () => {
    const req = parseCurl('curl --url https://api.example.com/y');
    expect(req.url).toBe('https://api.example.com/y');
  });

  test('--data-urlencode produces form fields', () => {
    const req = parseCurl("curl https://api.example.com/x --data-urlencode 'q=a b'");
    expect(req.body).toEqual({ type: 'form', fields: [{ key: 'q', value: 'a b', enabled: true }] });
  });

  test('raw non-form non-json data becomes a raw body', () => {
    const req = parseCurl("curl https://api.example.com/x --data 'just some text'");
    expect(req.body).toEqual({ type: 'raw', text: 'just some text', contentType: 'text/plain' });
  });

  test('multiple -d concatenate with &', () => {
    const req = parseCurl("curl https://api.example.com/x -d 'a=1' -d 'b=2'");
    expect(req.body).toEqual({
      type: 'form',
      fields: [
        { key: 'a', value: '1', enabled: true },
        { key: 'b', value: '2', enabled: true },
      ],
    });
  });

  test('ignored flags do not swallow the URL or break parsing', () => {
    const req = parseCurl("curl -L -k -s https://api.example.com/x -A 'agent/1.0'");
    expect(req.url).toBe('https://api.example.com/x');
    expect(req.method).toBe('GET');
  });

  test('-G sends data as query and keeps method GET', () => {
    const req = parseCurl("curl -G https://api.example.com/x --data 'a=1&b=2'");
    expect(req.method).toBe('GET');
    expect(req.body).toEqual({ type: 'none' });
    expect(req.query).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: '2', enabled: true },
    ]);
  });

  test('garbage input degrades to a valid request', () => {
    const req = parseCurl('???');
    expect(req.method).toBe('GET');
    expect(Array.isArray(req.query)).toBe(true);
    expect(Array.isArray(req.headers)).toBe(true);
    expect(req.body).toEqual({ type: 'none' });
  });
});
