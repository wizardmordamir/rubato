import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkFiles } from './walkFiles';

describe('walkFiles', () => {
  test('returns files (sorted, relative) and skips ignored dirs/files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rubato-walk-'));
    await Bun.write(join(root, 'a.txt'), 'a');
    await Bun.write(join(root, 'sub/b.md'), 'b');
    await Bun.write(join(root, 'node_modules/pkg/index.js'), 'x'); // ignored dir
    await Bun.write(join(root, '.DS_Store'), 'junk'); // ignored file

    const files = await walkFiles(root);
    expect(files.map((f) => f.relativePath)).toEqual(['a.txt', 'sub/b.md']);
    expect(files[0].fullPath).toBe(join(root, 'a.txt'));
  });

  test('respectGitignore honors nested .gitignore files (deepest wins)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rubato-walk-gi-'));
    await Bun.write(join(root, '.gitignore'), 'out/\n*.key\n');
    await Bun.write(join(root, 'keep.ts'), 'k');
    await Bun.write(join(root, 'app.key'), 'noise'); // ignored by *.key
    await Bun.write(join(root, 'out/bundle.js'), 'x'); // ignored dir
    await Bun.write(join(root, 'pkg/.gitignore'), '!debug.key\n'); // re-include here
    await Bun.write(join(root, 'pkg/debug.key'), 'd'); // negated → kept
    await Bun.write(join(root, 'pkg/other.key'), 'o'); // still ignored

    const files = await walkFiles(root, { respectGitignore: true });
    expect(files.map((f) => f.relativePath)).toEqual(['.gitignore', 'keep.ts', 'pkg/.gitignore', 'pkg/debug.key']);
  });

  test('extraIgnores applies root-wide; a .gitignore can re-include them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rubato-walk-conv-'));
    await Bun.write(join(root, 'main.ts'), 'm');
    await Bun.write(join(root, 'dead.ignore.ts'), 'd'); // extra-ignored
    await Bun.write(join(root, '___scratch/notes.md'), 'n'); // extra-ignored dir
    await Bun.write(join(root, '.gitignore'), '!dead.ignore.ts\n'); // re-include (extras are weakest)

    const files = await walkFiles(root, { respectGitignore: true, extraIgnores: ['___*', '*.ignore.*'] });
    const paths = files.map((f) => f.relativePath);
    expect(paths).toContain('main.ts');
    expect(paths).toContain('dead.ignore.ts'); // re-included by .gitignore negation
    expect(paths).not.toContain('___scratch/notes.md');
  });

  test('no options: behavior is unchanged (gitignore ignored)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rubato-walk-noopt-'));
    await Bun.write(join(root, '.gitignore'), 'secret.txt\n');
    await Bun.write(join(root, 'secret.txt'), 's');
    const files = await walkFiles(root);
    expect(files.map((f) => f.relativePath)).toEqual(['.gitignore', 'secret.txt']);
  });
});
