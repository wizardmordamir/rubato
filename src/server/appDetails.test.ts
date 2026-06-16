import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppConfig } from '../lib/apps';
import { appDetails } from './appDetails';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const asApp = (name: string, absolutePath: string): AppConfig => ({ name, absolutePath }) as unknown as AppConfig;

describe('appDetails', () => {
  test('returns README + git status for a real repo dir', async () => {
    // README discovery: a temp dir with a README (rubato's own root deliberately
    // has none — its overview doc isn't named README, to stay out of npm).
    const dir = await mkdtemp(join(tmpdir(), 'rubato-appdetails-readme-'));
    await writeFile(join(dir, 'README.md'), '# temp app\n\nhello');
    const r = await appDetails(asApp('tmp', dir));
    expect(r.readme?.name).toBe('README.md');
    expect((r.readme?.content.length ?? 0) > 0).toBe(true);

    // git status: the rubato repo root is a real git repo.
    const d = await appDetails(asApp('rubato', REPO_ROOT));
    expect(d.app).toBe('rubato');
    expect(d.git?.isRepo).toBe(true);
    expect(typeof d.git?.branch).toBe('string');
    expect(Array.isArray(d.git?.entries)).toBe(true);
  });

  test('degrades gracefully for a non-repo dir with no README', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-appdetails-'));
    const d = await appDetails(asApp('tmp', dir));
    expect(d.readme).toBeUndefined();
    expect(d.git?.isRepo).toBe(false);
    expect(d.git?.entries).toEqual([]);
  });
});
