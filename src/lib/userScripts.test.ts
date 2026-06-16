import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getUserScript, loadUserScripts } from './userScripts';

const dirs: string[] = [];
async function scriptsDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'rubato-scripts-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

test('discovers .ts scripts and reads sidecar metadata', async () => {
  const dir = await scriptsDir();
  await writeFile(join(dir, 'transform.ts'), '// noop\n');
  await writeFile(
    join(dir, 'transform.meta.json'),
    JSON.stringify({
      description: 'Transform the file',
      params: [{ name: 'sheet', type: 'string', description: 'sheet name', required: true }],
      timeout: 5000,
    }),
  );
  const [s] = await loadUserScripts(dir);
  expect(s.id).toBe('transform');
  expect(s.description).toBe('Transform the file');
  expect(s.params).toEqual([{ name: 'sheet', type: 'string', description: 'sheet name', required: true }]);
  expect(s.timeout).toBe(5000);
});

test('reads a scalar param default from the sidecar (booleans drive the toggle)', async () => {
  const dir = await scriptsDir();
  await writeFile(join(dir, 'toggle.ts'), '// noop\n');
  await writeFile(
    join(dir, 'toggle.meta.json'),
    JSON.stringify({
      params: [
        { name: 'store', type: 'boolean', default: true },
        { name: 'limit', type: 'number', default: 10 },
        { name: 'plain', type: 'string' },
      ],
    }),
  );
  const [s] = await loadUserScripts(dir);
  expect(s.params).toEqual([
    { name: 'store', type: 'boolean', description: undefined, required: false, default: true },
    { name: 'limit', type: 'number', description: undefined, required: false, default: 10 },
    { name: 'plain', type: 'string', description: undefined, required: false },
  ]);
});

test('a script with no sidecar gets name-from-filename and no params', async () => {
  const dir = await scriptsDir();
  await writeFile(join(dir, 'plain.ts'), '// noop\n');
  const [s] = await loadUserScripts(dir);
  expect(s.name).toBe('plain');
  expect(s.params).toBeUndefined();
});

test('skips sidecars, tests, throwaways, and non-ts files', async () => {
  const dir = await scriptsDir();
  await writeFile(join(dir, 'real.ts'), '');
  await writeFile(join(dir, 'real.test.ts'), '');
  await writeFile(join(dir, 'dead.ignore.ts'), '');
  await writeFile(join(dir, '___wip.ts'), '');
  await writeFile(join(dir, 'notes.md'), '');
  expect((await loadUserScripts(dir)).map((s) => s.id)).toEqual(['real']);
});

test('getUserScript resolves by id; missing dir yields nothing', async () => {
  const dir = await scriptsDir();
  await writeFile(join(dir, 'pick.ts'), '');
  expect((await getUserScript('pick', dir))?.id).toBe('pick');
  expect(await getUserScript('nope', dir)).toBeNull();
  expect(await loadUserScripts(join(dir, 'does-not-exist'))).toEqual([]);
});
