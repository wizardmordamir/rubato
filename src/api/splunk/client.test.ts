import { describe, expect, test } from 'bun:test';
import { ApiError } from '../client';
import { createSplunkClient, normalizeSearchCommand, parseExportResults } from './client';

describe('normalizeSearchCommand', () => {
  test('prepends `search` to bare terms', () => {
    expect(normalizeSearchCommand('index=main error')).toBe('search index=main error');
  });
  test('leaves an explicit `search` command alone', () => {
    expect(normalizeSearchCommand('search index=foo')).toBe('search index=foo');
  });
  test('leaves a leading pipe alone', () => {
    expect(normalizeSearchCommand('| metadata type=hosts')).toBe('| metadata type=hosts');
  });
  test('empty stays empty', () => {
    expect(normalizeSearchCommand('   ')).toBe('');
  });
});

describe('parseExportResults', () => {
  test('collects non-preview result rows and field order', () => {
    const ndjson = [
      '{"preview":true,"result":{"_time":"t0","status":"100"}}',
      '{"preview":false,"result":{"_time":"t1","status":"200"}}',
      '{"preview":false,"result":{"_time":"t2","host":"web1"}}',
      '',
    ].join('\n');
    const { fields, rows, count } = parseExportResults(ndjson);
    expect(count).toBe(2);
    expect(rows[0]).toEqual({ _time: 't1', status: '200' });
    expect(fields).toEqual(['_time', 'status', 'host']); // first-seen order, union across rows
  });

  test('skips unparseable lines', () => {
    const { count } = parseExportResults('not json\n{"preview":false,"result":{"a":"1"}}');
    expect(count).toBe(1);
  });

  test('throws on an ERROR message in the stream', () => {
    expect(() => parseExportResults('{"messages":[{"type":"ERROR","text":"bad search"}]}')).toThrow(/bad search/);
  });
});

describe('runSearch', () => {
  test('posts the form-encoded export request and parses results', async () => {
    let captured: { url: string; method?: string; body: string; auth: string | null } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured = {
        url: String(url),
        method: init?.method,
        body: String(init?.body),
        auth: headers.get('Authorization'),
      };
      return new Response('{"preview":false,"result":{"_time":"t1","msg":"hi"}}\n', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const splunk = createSplunkClient({ baseUrl: 'https://splunk.example:8089', token: 'tok', fetch: fakeFetch });
    const res = await splunk.runSearch('index=main error', { earliest: '-1h', count: 10 });

    expect(res.count).toBe(1);
    expect(res.rows[0]).toEqual({ _time: 't1', msg: 'hi' });
    expect(captured?.method).toBe('POST');
    expect(captured?.url).toBe('https://splunk.example:8089/services/search/jobs/export');
    expect(captured?.auth).toBe('Bearer tok');
    // Body is form-encoded with the normalized search + window.
    const params = new URLSearchParams(captured?.body ?? '');
    expect(params.get('search')).toBe('search index=main error');
    expect(params.get('output_mode')).toBe('json');
    expect(params.get('earliest_time')).toBe('-1h');
    expect(params.get('count')).toBe('10');
  });

  test('surfaces a non-2xx as ApiError', async () => {
    const fakeFetch = (async () =>
      new Response('denied', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof fetch;
    const splunk = createSplunkClient({ baseUrl: 'https://splunk.example:8089', token: 'tok', fetch: fakeFetch });
    await expect(splunk.runSearch('index=foo')).rejects.toBeInstanceOf(ApiError);
  });
});
