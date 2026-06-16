import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CONFIG_FILE, RUBATO_HOME } from '../lib/config';
import { readSystemHealthFile, runSystemHealth } from './systemHealth';

// RUBATO_HOME is isolated to a throwaway dir by the test preload (setup.ts), so
// these run against a sandboxed home and never touch the real ~/.rubato.

describe('runSystemHealth', () => {
  it('returns an aggregated report with the expected check shape', async () => {
    const report = await runSystemHealth();
    expect(report.results.length).toBe(5);
    const ids = report.results.map((r) => r.id).sort();
    expect(ids).toEqual(['apps_registered', 'config_file', 'env_file', 'output_dir', 'rubato_home'].sort());
    for (const r of report.results) {
      expect(typeof r.id).toBe('string');
      expect(['ok', 'info', 'warn', 'error']).toContain(r.status);
      expect(Array.isArray(r.remediation)).toBe(true);
    }
  });

  it('summary tallies match the result count and ok reflects errors', async () => {
    const { results, summary, ok } = await runSystemHealth();
    expect(summary.error + summary.warn + summary.info + summary.ok).toBe(results.length);
    expect(ok).toBe(summary.error === 0);
  });

  it('attaches structured, openable paths to the checks that reference files/dirs', async () => {
    const byId = new Map((await runSystemHealth()).results.map((r) => [r.id, r]));

    const home = byId.get('rubato_home')?.paths;
    expect(home).toEqual([{ label: 'RUBATO_HOME', path: RUBATO_HOME, kind: 'dir', exists: expect.any(Boolean) }]);

    const config = byId.get('config_file')?.paths;
    expect(config?.[0]).toMatchObject({ path: CONFIG_FILE, kind: 'file' });
    expect(typeof config?.[0].exists).toBe('boolean');
  });
});

describe('readSystemHealthFile', () => {
  it('reads an allowlisted file that exists', async () => {
    mkdirSync(RUBATO_HOME, { recursive: true });
    writeFileSync(CONFIG_FILE, '{"hello":"world"}');
    const result = await readSystemHealthFile(CONFIG_FILE);
    expect(result).toMatchObject({ ok: true, name: 'config.json', content: '{"hello":"world"}' });
  });

  it('refuses a path that is not on the allowlist', async () => {
    const result = await readSystemHealthFile('/etc/passwd');
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('404s an allowlisted file that does not exist', async () => {
    // .env is allowlisted but the sandbox home never creates one.
    const result = await readSystemHealthFile(`${RUBATO_HOME}/.env`);
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});
