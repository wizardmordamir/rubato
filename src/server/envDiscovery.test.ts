import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../lib/apps';
import { discoverEnvFromApps } from './envDiscovery';

type App = Pick<AppConfig, 'name' | 'group' | 'absolutePath'>;

async function appDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rubato-envdisc-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

async function fixture(): Promise<App[]> {
  const a = await appDir({
    '.env': 'API_URL=https://x\nSECRET=abc\n',
    'server/.env.prod': 'API_URL=https://prod\n',
  });
  const b = await appDir({ '.env': 'DATABASE_URL=pg://db\nPORT=5432\n' });
  const c = await appDir({ 'readme.md': 'no env here' }); // no .env* files → never scanned
  return [
    { name: 'alpha', group: 'web', absolutePath: a },
    { name: 'bravo', group: 'web', absolutePath: b },
    { name: 'charlie', group: 'tools', absolutePath: c },
  ];
}

describe('discoverEnvFromApps', () => {
  test('no query → lists only apps that carry .env* files, with their key names (no values)', async () => {
    const r = await discoverEnvFromApps(await fixture(), {});
    expect(r.scannedApps).toBe(2); // charlie excluded (no env files)
    expect(r.apps.map((a) => a.name).sort()).toEqual(['alpha', 'bravo']);
    const alpha = r.apps.find((a) => a.name === 'alpha');
    expect(alpha?.files.map((f) => f.path).sort()).toEqual(['.env', 'server/.env.prod']);
    expect(alpha?.files.find((f) => f.path === '.env')?.keys).toEqual(['API_URL', 'SECRET']);
    // groups span ALL apps (incl. charlie) so the UI filter can offer them
    expect(r.groups).toEqual(['tools', 'web']);
    // never leaks values
    expect(JSON.stringify(r)).not.toContain('https://x');
  });

  test("search 'with' returns only the configs that have the key", async () => {
    const r = await discoverEnvFromApps(await fixture(), { q: 'API', mode: 'with' });
    expect(r.apps.map((a) => a.name)).toEqual(['alpha']); // bravo has no API_* key
    expect(r.matchedApps).toBe(1);
    expect(r.apps[0].files.every((f) => f.matchedKeys.includes('API_URL'))).toBe(true);
  });

  test("search 'without' returns the configs that LACK the key", async () => {
    const r = await discoverEnvFromApps(await fixture(), { q: 'API', mode: 'without' });
    // alpha's two files both have API_URL → alpha drops; bravo's .env lacks it → kept
    expect(r.apps.map((a) => a.name)).toEqual(['bravo']);
    expect(r.apps[0].files[0].matchedKeys).toEqual([]);
  });

  test('group filter restricts the scan', async () => {
    const r = await discoverEnvFromApps(await fixture(), { group: 'tools' });
    expect(r.scannedApps).toBe(0); // charlie is the only 'tools' app and has no env files
    expect(r.apps).toEqual([]);
  });

  test("value search filters by a key's value without returning it", async () => {
    const r = await discoverEnvFromApps(await fixture(), { q: 'secret', value: 'abc', mode: 'with' });
    expect(r.apps.map((a) => a.name)).toEqual(['alpha']);
    expect(r.apps[0].files[0].matchedKeys).toEqual(['SECRET']);
    // the echoed search term may appear; an un-searched FILE value (API_URL's) must not.
    expect(JSON.stringify(r)).not.toContain('https://x');
  });
});
