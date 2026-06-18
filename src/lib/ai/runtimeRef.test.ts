import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../apps';
import { _clearRuntimeRefCache, buildRuntimeRef } from './runtimeRef';

/** Minimal AppConfig stub pointing at a temp dir with a given package.json. */
function appWith(pkg: Record<string, unknown> | null): { app: AppConfig; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rubato-rtref-'));
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
  const app = { name: 'demo', absolutePath: dir } as unknown as AppConfig;
  return { app, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

afterEach(() => _clearRuntimeRefCache());

describe('buildRuntimeRef', () => {
  test('always reports the Bun version and the app root', async () => {
    const { app, cleanup } = appWith(null);
    try {
      const block = await buildRuntimeRef(app, 'how do I do X?');
      expect(block).toContain('[Runtime Reference]');
      expect(block).toContain(`Bun ${Bun.version}`);
      expect(block).toContain(app.absolutePath);
    } finally {
      cleanup();
    }
  });

  test('lists declared dependencies', async () => {
    const { app, cleanup } = appWith({
      dependencies: { express: '^5.0.0' },
      devDependencies: { typescript: '^5.4.0' },
    });
    try {
      const block = await buildRuntimeRef(app, 'write an express route');
      expect(block).toContain('express@^5.0.0');
      expect(block).toContain('typescript@^5.4.0');
    } finally {
      cleanup();
    }
  });

  test('caps the dependency list', async () => {
    const deps: Record<string, string> = {};
    for (let i = 0; i < 80; i++) deps[`pkg-${i}`] = '1.0.0';
    const { app, cleanup } = appWith({ dependencies: deps });
    try {
      const block = await buildRuntimeRef(app, 'q');
      const listed = (block.match(/pkg-\d+@/g) ?? []).length;
      expect(listed).toBeLessThanOrEqual(40);
    } finally {
      cleanup();
    }
  });

  test('does not probe (or mention) tools that are not in the allowlist', async () => {
    const { app, cleanup } = appWith(null);
    try {
      const block = await buildRuntimeRef(app, 'how do I use someRandomBinaryThatIsNotAllowlisted?');
      expect(block).not.toContain('Installed tools');
    } finally {
      cleanup();
    }
  });

  test('probes an allowlisted, installed tool named in the question (git)', async () => {
    // git is present in any dev checkout; assert the probe surfaces a version line.
    if (!Bun.which('git')) return; // environment without git — skip the assertion
    const { app, cleanup } = appWith(null);
    try {
      const block = await buildRuntimeRef(app, 'write a git helper script');
      expect(block).toContain('Installed tools');
      expect(block).toMatch(/git: .+/);
    } finally {
      cleanup();
    }
  });
});
