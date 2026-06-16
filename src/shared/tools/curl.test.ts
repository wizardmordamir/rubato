import { describe, expect, test } from 'bun:test';
import { buildCurl, buildFetch, type CurlRequestInput } from './curl';

const base: CurlRequestInput = {
  method: 'GET',
  url: 'https://api.example.com/x',
  queryParams: [],
  headers: [],
  body: '',
  bodyType: 'none',
  auth: { type: 'none' },
  flags: [],
};

describe('buildCurl', () => {
  test('simple GET is just curl + quoted url', () => {
    expect(buildCurl(base)).toBe("curl \\\n  'https://api.example.com/x'");
  });

  test('method, query params, header, and json body', () => {
    const out = buildCurl({
      ...base,
      method: 'post',
      queryParams: [{ key: 'q', value: 'a b', enabled: true }],
      headers: [{ key: 'X-Trace', value: '1', enabled: true }],
      body: '{"a":1}',
      bodyType: 'json',
    });
    expect(out).toContain('-X POST');
    expect(out).toContain("'https://api.example.com/x?q=a%20b'");
    expect(out).toContain("-H 'X-Trace: 1'");
    expect(out).toContain("-H 'Content-Type: application/json'");
    expect(out).toContain('--data \'{"a":1}\'');
  });

  test('does not duplicate an explicit content-type', () => {
    const out = buildCurl({
      ...base,
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
      body: '{}',
      bodyType: 'json',
    });
    expect(out.match(/Content-Type/g)?.length).toBe(1);
  });

  test('bearer and basic auth', () => {
    expect(buildCurl({ ...base, auth: { type: 'bearer', token: 'tok' } })).toContain("-H 'Authorization: Bearer tok'");
    expect(buildCurl({ ...base, auth: { type: 'basic', username: 'u', password: 'p' } })).toContain("-u 'u:p'");
  });

  test('disabled rows and flags', () => {
    const out = buildCurl({
      ...base,
      flags: ['-L', '-s'],
      headers: [{ key: 'X-Off', value: '1', enabled: false }],
    });
    expect(out.startsWith('curl')).toBe(true);
    expect(out).toContain('-L');
    expect(out).toContain('-s');
    expect(out).not.toContain('X-Off');
  });
});

describe('buildFetch', () => {
  test('mirrors method, headers, auth, json body', () => {
    const out = buildFetch({
      ...base,
      method: 'POST',
      headers: [{ key: 'X-Trace', value: '1', enabled: true }],
      auth: { type: 'bearer', token: 'tok' },
      body: '{"a":1}',
      bodyType: 'json',
    });
    expect(out).toContain("fetch('https://api.example.com/x', {");
    expect(out).toContain("method: 'POST'");
    expect(out).toContain("'X-Trace': '1'");
    expect(out).toContain("'Authorization': 'Bearer tok'");
    expect(out).toContain("'Content-Type': 'application/json'");
    expect(out).toContain('body: JSON.stringify({"a":1})');
  });

  test('invalid json body falls back to a raw quoted string', () => {
    const out = buildFetch({ ...base, body: '{not json}', bodyType: 'json' });
    expect(out).toContain("body: '{not json}'");
  });

  test('basic auth uses btoa so the snippet runs as-is', () => {
    const out = buildFetch({ ...base, auth: { type: 'basic', username: 'u', password: 'p' } });
    expect(out).toContain("btoa('u:p')");
  });
});
