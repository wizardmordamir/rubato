/**
 * Integration: the on-disk script behind a built-in command, served to its detail
 * page via `route()`. The path comes only from the trusted registry, so a real
 * command resolves its source and an unknown name 404s (no traversal).
 */

import { describe, expect, test } from 'bun:test';
import type { CommandDef } from '../../commands';
import { apiGet, useHarness } from '../index';

useHarness();

describe('command source', () => {
  test('returns the registry script + its on-disk source for a real command', async () => {
    const commands = (await (await apiGet('/api/commands')).json()) as CommandDef[];
    const cmd = commands.find((c) => c.script);
    expect(cmd).toBeDefined();

    const res = await apiGet(`/api/commands/${encodeURIComponent(cmd!.name)}/source`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; script: string; source: string };
    expect(body.name).toBe(cmd!.name);
    expect(body.script).toBe(cmd!.script);
    expect(body.source.length).toBeGreaterThan(0);
  });

  test('unknown command → 404', async () => {
    expect((await apiGet('/api/commands/__no_such_command__/source')).status).toBe(404);
  });
});
