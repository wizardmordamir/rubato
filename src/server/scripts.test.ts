import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OUTPUTS_DIR } from '../lib/config';
import { clearRegisteredScripts, registerScript } from '../lib/scriptRegistry';
import { resolveScriptsDir } from '../lib/userScripts';
import { executeScriptById, listScripts, startScriptRun } from './scripts';

const cleanup: string[] = [];
afterEach(async () => {
  clearRegisteredScripts();
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

async function runDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'rubato-run-'));
  cleanup.push(d);
  return d;
}

test('runs a registered script in-process and returns its outcome vars', async () => {
  registerScript({
    id: 'make-report',
    async run({ dir, vars, log }) {
      log('writing report');
      await writeFile(join(dir, 'report.txt'), `hi ${vars.who}`);
      return { status: 'passed', vars: { wrote: 'report.txt' } };
    },
  });
  const dir = await runDir();
  const { outcome, output } = await executeScriptById('make-report', { dir, vars: { who: 'curt' }, params: {} });
  expect(outcome.status).toBe('passed');
  expect(outcome.vars).toEqual({ wrote: 'report.txt' });
  expect(output).toContain('writing report');
  expect(await readFile(join(dir, 'report.txt'), 'utf8')).toBe('hi curt');
});

test('a throwing registered script becomes a failed outcome', async () => {
  registerScript({
    id: 'boom',
    run() {
      throw new Error('kaboom');
    },
  });
  const { outcome } = await executeScriptById('boom', { dir: await runDir(), vars: {}, params: {} });
  expect(outcome.status).toBe('failed');
});

test('spawns a discovered file script with the run dir + vars, merges outputs.json', async () => {
  const scriptsDir = resolveScriptsDir();
  await mkdir(scriptsDir, { recursive: true });
  cleanup.push(resolve(scriptsDir, 'echo-stage.ts'));
  await writeFile(
    resolve(scriptsDir, 'echo-stage.ts'),
    [
      'const dir = process.env.RUBATO_RUN_DIR;',
      "console.log('NAME=' + process.env.NAME);",
      "await Bun.write(dir + '/outputs.json', JSON.stringify({ vars: { greeted: 'yes' } }));",
      '',
    ].join('\n'),
  );

  const dir = await runDir();
  const { outcome, output } = await executeScriptById('echo-stage', { dir, vars: { NAME: 'world' }, params: {} });
  expect(output).toContain('NAME=world');
  expect(outcome.status).toBe('passed');
  expect(outcome.vars).toEqual({ greeted: 'yes' });
});

test('listScripts surfaces registered scripts (registered id wins over a file)', async () => {
  registerScript({ id: 'dup', description: 'in-process', run: () => {} });
  const list = await listScripts();
  const dup = list.find((s) => s.id === 'dup');
  expect(dup?.source).toBe('registered');
  expect(dup?.description).toBe('in-process');
});

test('executeScriptById throws on an unknown id', async () => {
  await expect(executeScriptById('ghost', { dir: await runDir(), vars: {}, params: {} })).rejects.toThrow();
});

test('startScriptRun writes an informative failure file (reason + summary), not just a header', async () => {
  // A script that fails by RETURNING a detail and never logging — the case the
  // bare-header output file couldn't explain.
  registerScript({ id: 'needs-input', run: () => ({ status: 'failed', detail: { error: 'namespace is required' } }) });
  await startScriptRun('needs-input');
  const text = await readFile(resolve(OUTPUTS_DIR, 'script-needs-input.txt'), 'utf8');
  expect(text).toContain('status: failed');
  expect(text).toContain('run dir:');
  expect(text).toContain('why it failed');
  expect(text).toContain('namespace is required');
});

test('startScriptRun captures a registered script log + run dir on success', async () => {
  registerScript({
    id: 'chatty',
    run: ({ log }) => {
      log('did the thing');
      return { status: 'passed' };
    },
  });
  await startScriptRun('chatty');
  const text = await readFile(resolve(OUTPUTS_DIR, 'script-chatty.txt'), 'utf8');
  expect(text).toContain('status: passed');
  expect(text).toContain('did the thing');
});
