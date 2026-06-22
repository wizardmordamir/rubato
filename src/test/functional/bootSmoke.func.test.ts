/**
 * Functional: the promotion gate's RUNTIME boot smoke against the REAL `rubato-serve`.
 * `runBootSmoke(rubatoSmokeSpec(...))` spawns the actual server binary (the same one a
 * user runs) from this checkout, isolated to a throwaway RUBATO_HOME + a free port,
 * waits for `/api/health`, then tears it down — proving the gate's smoke succeeds on a
 * healthy build and FAILS (rather than hangs or throws) on one that can't boot.
 *
 * This is the signal a `bun run build` can't give: the server actually RUNS.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pickFreePort, rubatoSmokeSpec, runBootSmoke, smokeHomeDir } from '../../server/taskq/bootSmoke';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.map((h) => rm(h, { recursive: true, force: true }).catch(() => {})));
});

describe('promotion-gate boot smoke (real rubato-serve)', () => {
  test('a healthy build boots + answers /api/health → smoke green', async () => {
    const port = await pickFreePort();
    const homeDir = smokeHomeDir('ru-func', `${process.pid}-ok`);
    homes.push(homeDir);
    const res = await runBootSmoke(rubatoSmokeSpec({ cwd: REPO_ROOT, port, homeDir, timeoutMs: 45_000 }));
    if (!res.ok) console.error('boot smoke unexpectedly failed:', res.detail, '\n', res.logTail);
    expect(res.ok).toBe(true);
    expect(res.repo).toBe('ru');
    expect(res.detail).toContain('/api/health');
    expect(res.durationMs).toBeGreaterThan(0);
  }, 60_000);

  test('a non-bootable command → smoke RED (reported, not thrown) within the bound', async () => {
    const port = await pickFreePort();
    const homeDir = smokeHomeDir('ru-func', `${process.pid}-bad`);
    homes.push(homeDir);
    // A command that exits immediately never serves health → the smoke must fail fast,
    // not hang to the full timeout and not throw.
    const res = await runBootSmoke({
      repo: 'ru',
      cmd: ['bun', '-e', 'process.exit(0)'],
      cwd: REPO_ROOT,
      port,
      healthPath: '/api/health',
      homeEnvVar: 'RUBATO_HOME',
      homeDir,
      portEnvVar: 'RUBATO_PORT',
      timeoutMs: 8_000,
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('boot smoke failed');
  }, 30_000);
});
