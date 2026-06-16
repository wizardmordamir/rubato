import { describe, expect, test } from 'bun:test';
import { findService, runServiceOperation, SERVICE_CATALOG } from './serviceCatalog';

describe('SERVICE_CATALOG', () => {
  test('every service has a unique name, a label, and at least one operation', () => {
    const names = SERVICE_CATALOG.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SERVICE_CATALOG) {
      expect(s.name).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.envHint).toBeTruthy();
      expect(s.operations.length).toBeGreaterThan(0);
      for (const op of s.operations) {
        expect(op.key).toBeTruthy();
        expect(op.label).toBeTruthy();
        for (const p of op.params) {
          expect(p.name).toBeTruthy();
          expect(p.label).toBeTruthy();
        }
      }
    }
  });

  test('covers the five new clients plus gitlab/quay/splunk', () => {
    const names = SERVICE_CATALOG.map((s) => s.name);
    for (const n of ['datadog', 'dynatrace', 'github', 'rancher', 'harness', 'gitlab', 'quay', 'splunk']) {
      expect(names).toContain(n);
    }
  });

  test('findService resolves by name', () => {
    expect(findService('github')?.label).toBe('GitHub');
    expect(findService('nope')).toBeUndefined();
  });
});

describe('runServiceOperation dispatch guards', () => {
  // These reject before any client is constructed (no network/config IO).
  test('unknown service', async () => {
    await expect(runServiceOperation('nope', 'x')).rejects.toThrow(/unknown service/);
  });

  test('unknown operation', async () => {
    await expect(runServiceOperation('datadog', 'nope')).rejects.toThrow(/unknown operation/);
  });

  test('missing required param is caught before connecting', async () => {
    await expect(runServiceOperation('datadog', 'searchLogs', {})).rejects.toThrow(/missing required/);
    await expect(runServiceOperation('github', 'getRepo', {})).rejects.toThrow(/missing required.*repo/);
    await expect(runServiceOperation('splunk', 'runSearch', {})).rejects.toThrow(/missing required.*query/);
  });
});
