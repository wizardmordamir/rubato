import { expect, test } from 'bun:test';
import type { Pipeline, PipelineStage } from '../shared/pipeline';
import { runPipeline, type StageExecutor, type StageExecutorMap } from './pipelineRunner';

function pipeline(stages: PipelineStage[]): Pipeline {
  return { id: 'p', name: 'P', stages, createdAt: 0, updatedAt: 0 };
}

test("vars flow forward: stage 2 sees stage 1's declared vars", async () => {
  const seen: Record<string, string>[] = [];
  const exec: StageExecutor = {
    async run(stage, ctx) {
      seen.push({ ...ctx.vars });
      return stage.id === 'a' ? { status: 'passed', vars: { token: 'xyz' } } : { status: 'passed' };
    },
  };
  const result = await runPipeline(
    pipeline([
      { id: 'a', kind: 'script', ref: 'one' },
      { id: 'b', kind: 'script', ref: 'two' },
    ]),
    { dir: '/tmp/run', vars: { seed: '1' }, executors: { script: exec } },
  );
  expect(result.status).toBe('passed');
  expect(seen[0]).toEqual({ seed: '1' });
  expect(seen[1]).toEqual({ seed: '1', token: 'xyz' });
  expect(result.vars).toEqual({ seed: '1', token: 'xyz' });
});

test('with overrides interpolate ${run.dir}/${VAR} and layer per-stage only', async () => {
  const seen: Record<string, string>[] = [];
  const exec: StageExecutor = {
    async run(_stage, ctx) {
      seen.push({ ...ctx.vars });
      return { status: 'passed' };
    },
  };
  await runPipeline(
    pipeline([
      { id: 'a', kind: 'script', ref: 'x', with: { path: '${run.dir}/in.csv', who: '${seed}' } },
      { id: 'b', kind: 'script', ref: 'y' },
    ]),
    { dir: '/tmp/run', vars: { seed: 'tmDir' }, executors: { script: exec } },
  );
  expect(seen[0]).toEqual({ seed: 'tmDir', path: '/tmp/run/in.csv', who: 'tmDir' });
  // The `with` overrides don't leak into the bag for the next stage.
  expect(seen[1]).toEqual({ seed: 'tmDir' });
});

test('a failed stage hard-stops the pipeline', async () => {
  const ran: string[] = [];
  const exec: StageExecutor = {
    async run(stage) {
      ran.push(stage.id);
      return { status: stage.id === 'a' ? 'failed' : 'passed' };
    },
  };
  const result = await runPipeline(
    pipeline([
      { id: 'a', kind: 'script', ref: 'x' },
      { id: 'b', kind: 'script', ref: 'y' },
    ]),
    { dir: '/tmp/run', executors: { script: exec } },
  );
  expect(ran).toEqual(['a']);
  expect(result.status).toBe('failed');
  expect(result.stages).toHaveLength(1);
});

test('continueOnError keeps going past a failed stage', async () => {
  const ran: string[] = [];
  const exec: StageExecutor = {
    async run(stage) {
      ran.push(stage.id);
      return { status: stage.id === 'a' ? 'failed' : 'passed' };
    },
  };
  const result = await runPipeline(
    pipeline([
      { id: 'a', kind: 'script', ref: 'x', continueOnError: true },
      { id: 'b', kind: 'script', ref: 'y' },
    ]),
    { dir: '/tmp/run', executors: { script: exec } },
  );
  expect(ran).toEqual(['a', 'b']);
  expect(result.status).toBe('failed'); // overall still failed
});

test('a thrown executor + a missing executor both become failed stages', async () => {
  const exec: StageExecutor = {
    async run() {
      throw new Error('boom');
    },
  };
  const executors: StageExecutorMap = { script: exec };
  const result = await runPipeline(
    pipeline([
      { id: 'a', kind: 'script', ref: 'x', continueOnError: true },
      { id: 'b', kind: 'excel', ref: 'y' },
    ]),
    { dir: '/tmp/run', executors },
  );
  expect(result.stages[0].status).toBe('failed');
  expect(result.stages[0].error).toContain('boom');
  expect(result.stages[1].status).toBe('failed');
  expect(result.stages[1].error).toContain('no executor');
});

test('onStage fires running then a terminal status for each stage', async () => {
  const events: string[] = [];
  const exec: StageExecutor = {
    async run() {
      return { status: 'passed' };
    },
  };
  await runPipeline(pipeline([{ id: 'a', kind: 'script', ref: 'x', label: 'Step A' }]), {
    dir: '/tmp/run',
    executors: { script: exec },
    onStage: (p) => events.push(`${p.label}:${p.status}`),
  });
  expect(events).toEqual(['Step A:running', 'Step A:passed']);
});
