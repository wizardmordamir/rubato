import { describe, expect, test } from 'bun:test';
import type { SplunkAppApi } from '../../lib/appApis';
import { buildSplunkQuery, findSearch } from './queryBuilder';

describe('buildSplunkQuery', () => {
  test('assembles the canonical query from a saved search + env', () => {
    const app: SplunkAppApi = {
      name: 'splunk',
      index: 'main',
      appId: 'my-app',
      searches: [{ label: 'Audit logs', search: '/api/v*/audit' }],
    };
    const { query, missing } = buildSplunkQuery(app, { env: 'prod', search: 'Audit logs' });
    expect(query).toBe('index=main dom IN("my-app-prod") /api/v*/audit');
    expect(missing).toEqual([]);
  });

  test('appId falls back to the `app` option (the route passes dirName)', () => {
    const app: SplunkAppApi = { name: 'splunk', index: 'main' };
    const { query } = buildSplunkQuery(app, { env: 'dev', app: 'billing' });
    expect(query).toBe('index=main dom IN("billing-dev")');
  });

  test('precedence: call option > saved search > app > global default', () => {
    const app: SplunkAppApi = {
      name: 'splunk',
      index: 'app-default',
      appId: 'svc',
      searches: [{ label: 'Errors', index: 'search-default' }],
    };
    // option wins
    expect(buildSplunkQuery(app, { env: 'test', search: 'Errors', index: 'call-override' }).parts.index).toBe(
      'call-override',
    );
    // saved-search wins over app
    expect(buildSplunkQuery(app, { env: 'test', search: 'Errors' }).parts.index).toBe('search-default');
    // app wins over global default
    expect(buildSplunkQuery(app, { env: 'test', defaults: { index: 'global' } }).parts.index).toBe('app-default');
  });

  test('global defaults supply index, domain pattern, and clause shape', () => {
    const app: SplunkAppApi = { name: 'splunk', appId: 'svc' };
    const { query } = buildSplunkQuery(app, {
      env: 'prod',
      defaults: { index: 'main', domain: '${app}.${env}', domainClause: 'domain=${domain}' },
    });
    expect(query).toBe('index=main domain=svc.prod');
  });

  test('reports missing interpolation variables', () => {
    const app: SplunkAppApi = { name: 'splunk', index: 'main', appId: 'svc' };
    const { missing } = buildSplunkQuery(app, { search: undefined }); // no env
    expect(missing).toContain('env');
  });

  test('custom vars interpolate into the search fragment', () => {
    const app: SplunkAppApi = {
      name: 'splunk',
      index: 'main',
      appId: 'svc',
      searches: [{ label: 'By id', search: 'transactionId=${txid}' }],
    };
    const { query, missing } = buildSplunkQuery(app, {
      env: 'prod',
      search: 'By id',
      vars: { txid: 'abc123' },
    });
    expect(query).toBe('index=main dom IN("svc-prod") transactionId=abc123');
    expect(missing).toEqual([]);
  });

  test('free-text `extra` terms append verbatim; `fragment` overrides the template', () => {
    const app: SplunkAppApi = {
      name: 'splunk',
      index: 'main',
      appId: 'svc',
      searches: [{ label: 'Audit', search: '/audit' }],
    };
    const { query } = buildSplunkQuery(app, {
      env: 'prod',
      search: 'Audit',
      fragment: '/health',
      extra: '| stats count by status',
    });
    expect(query).toBe('index=main dom IN("svc-prod") /health | stats count by status');
  });

  test('empty domain pattern drops the domain clause entirely', () => {
    const app: SplunkAppApi = { name: 'splunk', index: 'main', domain: '' };
    const { query } = buildSplunkQuery(app, { env: 'prod', app: 'svc', extra: 'error' });
    expect(query).toBe('index=main error');
  });

  test('custom (app-less): empty config + inline inputs build a standalone query', () => {
    // Mirrors the route's no-app path: an empty `{ name: "splunk" }` config, the
    // `${app}` value passed inline, and a literal empty domain (= no filter).
    const empty: SplunkAppApi = { name: 'splunk' };
    const { query, missing } = buildSplunkQuery(empty, {
      app: 'infra',
      env: 'prod',
      index: 'main',
      domain: '${app}-${env}',
      extra: 'error | stats count',
    });
    expect(query).toBe('index=main dom IN("infra-prod") error | stats count');
    expect(missing).toEqual([]);

    // Blank domain in custom mode → just the index + free-text terms, no missing vars.
    const raw = buildSplunkQuery(empty, { index: 'main', domain: '', extra: 'sourcetype=access_combined' });
    expect(raw.query).toBe('index=main sourcetype=access_combined');
    expect(raw.missing).toEqual([]);
  });
});

describe('findSearch', () => {
  const app: SplunkAppApi = { name: 'splunk', searches: [{ label: 'Audit Logs' }] };
  test('matches case-insensitively', () => {
    expect(findSearch(app, 'audit logs')?.label).toBe('Audit Logs');
  });
  test('undefined label → undefined', () => {
    expect(findSearch(app, undefined)).toBeUndefined();
  });
});
