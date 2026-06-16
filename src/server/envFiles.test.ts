import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEnvFileName, listAppEnvFiles, readAppEnvFile, writeAppEnvFile } from './envFiles';

async function makeApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rubato-env-'));
  await writeFile(join(root, '.env'), 'API_URL=https://x\nSECRET=abc\n');
  await mkdir(join(root, 'server'), { recursive: true });
  await writeFile(join(root, 'server', '.env.prod'), 'API_URL=https://prod\n');
  await writeFile(join(root, 'notes.txt'), 'not an env file');
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'pkg', '.env'), 'NOPE=1');
  return root;
}

describe('isEnvFileName', () => {
  test('matches .env variants and *.env, not arbitrary files', () => {
    for (const n of ['.env', '.env.prod', 'env.sample', '.env.local', 'local.env']) expect(isEnvFileName(n)).toBe(true);
    for (const n of ['notes.txt', 'environment.ts', 'readme.md']) expect(isEnvFileName(n)).toBe(false);
  });
});

describe('listAppEnvFiles', () => {
  test('finds .env files (incl. subdir) and skips node_modules + non-env files', async () => {
    const root = await makeApp();
    const found = (await listAppEnvFiles(root)).map((f) => f.path).sort();
    expect(found).toEqual(['.env', 'server/.env.prod']);
  });
});

describe('read/write within the app', () => {
  test('reads, writes, and round-trips a file', async () => {
    const root = await makeApp();
    const read = await readAppEnvFile(root, '.env');
    expect(read.ok && read.content.includes('API_URL=https://x')).toBe(true);

    const wrote = await writeAppEnvFile(root, 'server/.env.prod', 'A=1\nB=2\n');
    expect(wrote.ok).toBe(true);
    const back = await readAppEnvFile(root, 'server/.env.prod');
    expect(back.ok && back.content).toBe('A=1\nB=2\n');
  });
});

describe('path safety', () => {
  test('refuses traversal/escape', async () => {
    const root = await makeApp();
    const r = await readAppEnvFile(root, '../../../etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  test('refuses a non-env filename even inside the app', async () => {
    const root = await makeApp();
    const r = await readAppEnvFile(root, 'notes.txt');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});
