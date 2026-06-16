import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getFsTools } from './fsTools';

let root: string;
let tools: ReturnType<typeof getFsTools>;
const byName = (n: string) => tools.find((t) => t.spec.name === n);
const ctx = {}; // fs tools ignore the context

beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'fsTools-'));
  await writeFile(resolve(root, 'readme.md'), 'hello world\nsecond line\nTODO: fix me\n');
  await writeFile(resolve(root, 'app.ts'), 'export const x = 1; // TODO later\n');
  await writeFile(resolve(root, '.env'), 'SECRET=should-never-be-read\n');
  await mkdir(resolve(root, 'node_modules/pkg'), { recursive: true });
  await writeFile(resolve(root, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
  await mkdir(resolve(root, 'src'), { recursive: true });
  await writeFile(resolve(root, 'src/util.ts'), 'export const TODO = true;\n');
  tools = getFsTools(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('list_files', () => {
  test('lists files but excludes secrets and node_modules', async () => {
    const r = await byName('list_files')!.run(ctx, {});
    expect(r.ok).toBe(true);
    expect(r.content).toContain('readme.md');
    expect(r.content).toContain('src/util.ts');
    expect(r.content).not.toContain('.env');
    expect(r.content).not.toContain('node_modules');
  });

  test('glob filter (top-level *.ts matches only root files)', async () => {
    const r = await byName('list_files')!.run(ctx, { glob: '*.ts' });
    expect(r.content).toContain('app.ts');
    expect(r.content).not.toContain('src/util.ts'); // has a slash → not matched by *.ts
    expect(r.content).not.toContain('readme.md');
  });

  test('glob filter (src/*.ts matches the nested file)', async () => {
    const r = await byName('list_files')!.run(ctx, { glob: 'src/*.ts' });
    expect(r.content).toContain('src/util.ts');
    expect(r.content).not.toContain('app.ts');
  });
});

describe('read_file', () => {
  test('reads a file with line numbers', async () => {
    const r = await byName('read_file')!.run(ctx, { path: 'readme.md' });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('hello world');
    expect(r.sources?.[0].relativePath).toBe('readme.md');
  });

  test('refuses a secret file', async () => {
    const r = await byName('read_file')!.run(ctx, { path: '.env' });
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain('should-never-be-read');
  });

  test('refuses traversal outside the root', async () => {
    const r = await byName('read_file')!.run(ctx, { path: '../../etc/passwd' });
    expect(r.ok).toBe(false);
  });
});

describe('search_files', () => {
  test('finds matching lines across files', async () => {
    const r = await byName('search_files')!.run(ctx, { query: 'TODO' });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('readme.md:');
    expect(r.content).toContain('app.ts:');
    expect((r.sources ?? []).length).toBeGreaterThan(0);
  });

  test('never surfaces secret-file contents', async () => {
    const r = await byName('search_files')!.run(ctx, { query: 'SECRET' });
    // .env is skipped by the walk, so its SECRET line is never matched.
    expect(r.content).not.toContain('should-never-be-read');
  });
});
