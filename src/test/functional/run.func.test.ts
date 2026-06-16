/**
 * Functional: POST /api/run actually executes a registered command as a
 * subprocess (`runCommand` → `Bun.spawn`) and records it. The integration tests
 * call command *logic* directly; this proves the real run pipeline — spawn,
 * capture, exit code, persistence — against a seeded sandbox registry.
 */

import { describe, expect, test } from 'bun:test';
import type { RunRecord } from '../../shared/types';
import { useFunctional } from '../index';

const h = useFunctional();

const postRun = (body: unknown) =>
  h.server.request('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/run', () => {
  test('runs a registered command and records its captured output', async () => {
    const res = await postRun({ command: 'rubato-scan', args: [] });
    expect(res.status).toBe(200);
    const { run } = (await res.json()) as { run: RunRecord };
    expect(run.command).toBe('rubato-scan');
    expect(run.exitCode).toBe(0);
    // The seeded sandbox scaffolds real repos, so the scan finds them.
    expect(run.output).toMatch(/Found \d+ repos/i);
  });

  test('rejects an unknown command (400)', async () => {
    const res = await postRun({ command: 'definitely-not-a-command' });
    expect(res.status).toBe(400);
  });

  test('the run is persisted to /api/runs history', async () => {
    const res = await h.server.request('/api/runs');
    expect(res.ok).toBe(true);
    const runs = (await res.json()) as RunRecord[];
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.some((r) => r.command === 'rubato-scan')).toBe(true);
  });
});
