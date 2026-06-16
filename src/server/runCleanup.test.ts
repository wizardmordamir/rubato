import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deleteRunArtifacts } from '../lib/runArtifacts';
import { resolveOutputDir } from '../lib/runStore';
import {
  deleteAutomationRun,
  deleteAutomationRuns,
  getAutomationRun,
  listAutomationRuns,
  recordAutomationRun,
} from './db';

// Isolated by testSetup (RUBATO_HOME → a throwaway dir); a unique name keeps these
// rows from colliding with other specs that record runs.
const NAME = 'CLEANUP_SPEC';
const rec = (automationId: string, startedAt: number) =>
  recordAutomationRun({
    automation: NAME,
    automationId,
    status: 'passed',
    steps: [],
    scraped: {},
    startedAt,
    durationMs: 1,
  });

test('recordAutomationRun round-trips correlationId (for the server-logs lookup)', () => {
  const r = recordAutomationRun({
    automation: NAME,
    automationId: 'auto0',
    correlationId: 'corr-xyz',
    status: 'passed',
    steps: [],
    scraped: {},
    startedAt: 99,
    durationMs: 1,
  });
  expect(getAutomationRun(r.id)?.correlationId).toBe('corr-xyz');
});

test('deleteAutomationRun removes a single row', () => {
  const r = rec('auto1', 111);
  expect(getAutomationRun(r.id)).toBeTruthy();
  expect(deleteAutomationRun(r.id)).toBe(true);
  expect(getAutomationRun(r.id)).toBeNull();
  expect(deleteAutomationRun(r.id)).toBe(false); // already gone
});

test('deleteAutomationRuns(name) clears that automation and returns rows for cleanup', () => {
  rec('auto2', 221);
  rec('auto2', 222);
  const removed = deleteAutomationRuns(NAME);
  expect(removed.length).toBeGreaterThanOrEqual(2);
  // each removed row carries the id needed to locate its artifacts
  expect(removed.every((r) => r.automationId === 'auto2' || typeof r.automationId === 'string')).toBe(true);
  expect(listAutomationRuns(NAME)).toHaveLength(0);
});

test('deleteRunArtifacts removes the run output directory', async () => {
  const out = await resolveOutputDir();
  const dir = resolve(out, 'automation-runs', 'auto3-333');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, '0.html'), '<html/>');
  expect(existsSync(dir)).toBe(true);

  await deleteRunArtifacts({ automationId: 'auto3', startedAt: 333 });
  expect(existsSync(dir)).toBe(false);
});

test('deleteRunArtifacts is a no-op for a run with no automationId (older row)', async () => {
  // The older-row path (no automationId) must resolve without throwing and do nothing.
  await expect(deleteRunArtifacts({ automationId: undefined, startedAt: 1 })).resolves.toBeUndefined();
});
