import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { CONFIG_FILE, clearConfigCache, loadConfig, normalizeCodeDirs } from './config';

const home = homedir();

describe('normalizeCodeDirs', () => {
  test('defaults to ~/code when nothing is set', () => {
    expect(normalizeCodeDirs({})).toEqual([resolve(home, 'code')]);
  });

  test('accepts the legacy single codeDir string', () => {
    expect(normalizeCodeDirs({ codeDir: '~/work' })).toEqual([resolve(home, 'work')]);
  });

  test('accepts a codeDirs array and expands each', () => {
    expect(normalizeCodeDirs({ codeDirs: ['~/code', '/srv/apps'] })).toEqual([resolve(home, 'code'), '/srv/apps']);
  });

  test('unions codeDir and codeDirs when both are present', () => {
    expect(normalizeCodeDirs({ codeDir: '~/code', codeDirs: ['~/work'] })).toEqual([
      resolve(home, 'code'),
      resolve(home, 'work'),
    ]);
  });

  test('dedupes repeated roots after expansion', () => {
    expect(normalizeCodeDirs({ codeDir: '~/code', codeDirs: ['~/code', '~/code'] })).toEqual([resolve(home, 'code')]);
  });

  test('drops empty/blank/non-string entries', () => {
    expect(normalizeCodeDirs({ codeDirs: ['', '  ', 42, null, '~/work'] as unknown[] })).toEqual([
      resolve(home, 'work'),
    ]);
  });

  test('tolerates a stringy codeDirs (not an array)', () => {
    expect(normalizeCodeDirs({ codeDirs: '~/work' })).toEqual([resolve(home, 'work')]);
  });
});

// RUBATO_HOME (hence CONFIG_FILE) is isolated to a temp dir in src/test/setup.ts.
describe('loadConfig sanitizes removed knobs', () => {
  test('drops top-level outputDir and automations.scriptsDir, keeps timeout', async () => {
    const prev = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
    try {
      mkdirSync(dirname(CONFIG_FILE), { recursive: true });
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({
          codeDirs: ['~/code'],
          editor: 'code',
          // Knobs we removed — an old config.json may still carry them.
          outputDir: '/tmp/somewhere-else',
          automations: { scriptsDir: '/tmp/their-scripts', timeout: 1234 },
        }),
      );
      clearConfigCache();
      const cfg = await loadConfig();
      const loose = cfg as unknown as Record<string, unknown>;
      // Removed knobs are gone, so a later saveConfig can't write them back…
      expect(loose.outputDir).toBeUndefined();
      expect((loose.automations as Record<string, unknown> | undefined)?.scriptsDir).toBeUndefined();
      // …while the legitimate per-script timeout is preserved.
      expect(cfg.automations?.timeout).toBe(1234);
    } finally {
      if (prev != null) writeFileSync(CONFIG_FILE, prev);
      else rmSync(CONFIG_FILE, { force: true });
      clearConfigCache();
    }
  });
});
