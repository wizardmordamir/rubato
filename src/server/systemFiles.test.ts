import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { globalClaudePath, listSystemFiles, readSystemFile, writeSystemFile } from './systemFiles';

// The `claude` entry resolves under CLAUDE_CONFIG_DIR, so we can isolate it to a
// temp dir and exercise read/write without touching the real ~/.claude/CLAUDE.md.
// (The shell/git dotfiles resolve under the real $HOME; we only assert they're
// *listed*, never write them.)
let dir: string;
const prev = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rubato-sysfiles-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
});
afterEach(async () => {
  if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prev;
  await rm(dir, { recursive: true, force: true });
});

describe('systemFiles', () => {
  it('resolves the CLAUDE.md path under CLAUDE_CONFIG_DIR', () => {
    expect(globalClaudePath()).toBe(resolve(dir, 'CLAUDE.md'));
  });

  it('lists the allowlist (CLAUDE.md is markdown; shell/git dotfiles present)', async () => {
    const files = await listSystemFiles();
    const claude = files.find((f) => f.key === 'claude');
    expect(claude).toBeDefined();
    expect(claude?.markdown).toBe(true);
    expect(claude?.path).toBe(resolve(dir, 'CLAUDE.md'));
    expect(claude?.exists).toBe(false); // isolated temp dir, nothing written yet
    for (const key of ['zshrc', 'bashrc', 'bash_profile', 'gitconfig', 'gitignore_global']) {
      expect(files.some((f) => f.key === key)).toBe(true);
    }
  });

  it('reports not-exists with empty content when absent', async () => {
    const doc = await readSystemFile('claude');
    expect(doc?.exists).toBe(false);
    expect(doc?.content).toBe('');
    expect(doc?.path).toBe(resolve(dir, 'CLAUDE.md'));
  });

  it('writes (creating the file) then reads it back', async () => {
    const written = await writeSystemFile('claude', '# hi\n\nrules here');
    expect(written?.exists).toBe(true);
    expect(written?.content).toBe('# hi\n\nrules here');
    expect(await readFile(resolve(dir, 'CLAUDE.md'), 'utf8')).toBe('# hi\n\nrules here');

    const read = await readSystemFile('claude');
    expect(read?.exists).toBe(true);
    expect(read?.content).toBe('# hi\n\nrules here');
  });

  it('returns null for an unknown key (no path-traversal surface)', async () => {
    expect(await readSystemFile('../../etc/passwd')).toBeNull();
    expect(await writeSystemFile('nope', 'x')).toBeNull();
  });

  it('rejects content over the size cap', async () => {
    await expect(writeSystemFile('claude', 'x'.repeat(1_000_001))).rejects.toThrow(/too large/);
  });
});
