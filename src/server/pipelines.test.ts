import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clearRegisteredScripts, registerScript } from '../lib/scriptRegistry';
import { resolveScriptsDir } from '../lib/userScripts';
import type { Pipeline } from '../shared/pipeline';
import { listPipelineRuns } from './db';
import { startPipelineRun } from './pipelines';

const cleanup: string[] = [];
afterEach(async () => {
  clearRegisteredScripts();
  for (const f of cleanup.splice(0)) await rm(f, { recursive: true, force: true });
});

function pipeline(stages: Pipeline['stages']): Pipeline {
  return { id: 'ci', name: 'CI', stages, createdAt: 0, updatedAt: 0 };
}

test('runs a two-script pipeline: vars flow forward, files share the run dir, DB records it', async () => {
  // Stage 1: a registered fn writes a file into the run dir and declares a var.
  registerScript({
    id: 'produce',
    async run({ dir, vars }) {
      await writeFile(resolve(dir, 'data.txt'), `seed=${vars.seed}`);
      return { status: 'passed', vars: { produced: 'data.txt' } };
    },
  });

  // Stage 2: a discovered file script reads the prior file + the merged var.
  const scriptsDir = resolveScriptsDir();
  await mkdir(scriptsDir, { recursive: true });
  cleanup.push(resolve(scriptsDir, 'consume.ts'));
  await writeFile(
    resolve(scriptsDir, 'consume.ts'),
    [
      'const dir = process.env.RUBATO_RUN_DIR;',
      "const text = await Bun.file(dir + '/' + process.env.produced).text();",
      "console.log('read: ' + text);",
      "await Bun.write(dir + '/outputs.json', JSON.stringify({ vars: { consumed: 'ok' } }));",
      '',
    ].join('\n'),
  );

  const run = await startPipelineRun(
    pipeline([
      { id: 's1', kind: 'script', ref: 'produce' },
      { id: 's2', kind: 'script', ref: 'consume' },
    ]),
    { seed: '42' },
  );

  expect(run.status).toBe('passed');
  expect(run.vars).toMatchObject({ seed: '42', produced: 'data.txt', consumed: 'ok' });
  expect(run.stages.map((s) => s.status)).toEqual(['passed', 'passed']);
  // The file written by stage 1 is present in the shared run dir for stage 2.
  expect(await readFile(resolve(run.dir, 'data.txt'), 'utf8')).toBe('seed=42');
  // Stage 2 captured its stdout.
  expect(run.stages[1].output).toContain('read: seed=42');
  // It's persisted in the pipeline_runs history.
  expect(listPipelineRuns('CI').some((r) => r.id === run.id)).toBe(true);
  cleanup.push(run.dir);
});

test('a failing stage hard-stops and records a failed run', async () => {
  registerScript({ id: 'ok', run: () => ({ status: 'passed' }) });
  registerScript({
    id: 'fail',
    run() {
      throw new Error('nope');
    },
  });
  registerScript({ id: 'never', run: () => ({ status: 'passed' }) });

  const run = await startPipelineRun(
    pipeline([
      { id: 'a', kind: 'script', ref: 'ok' },
      { id: 'b', kind: 'script', ref: 'fail' },
      { id: 'c', kind: 'script', ref: 'never' },
    ]),
  );
  expect(run.status).toBe('failed');
  expect(run.stages).toHaveLength(2); // third stage never ran
  cleanup.push(run.dir);
});
