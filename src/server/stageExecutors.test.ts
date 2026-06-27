import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runPipeline } from '../lib/pipelineRunner';
import type { Pipeline, PipelineStage } from '../shared/pipeline';
import { stageExecutors } from './stageExecutors';

// End-to-end check of the `transform` stage executor through the real runner +
// production executor map: a prior step's output (a JSON file / a var / the bag)
// is mapped into named vars that flow to later stages. Scoped to the transform
// kind (no automation/script/excel engine needed), so it boots no server.

function pipeline(stages: PipelineStage[]): Pipeline {
  return { id: 'p', name: 'P', stages, createdAt: 0, updatedAt: 0 };
}

describe('transform stage executor', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(resolve(tmpdir(), 'rubato-transform-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('maps fields from a JSON file a prior step wrote into vars', async () => {
    // Simulates an AI/scan step that dropped a structured report in the run dir.
    await writeFile(
      resolve(dir, 'scan.json'),
      JSON.stringify({ app: 'billing-svc', summary: { critical: 3, high: 7 }, findings: [{ id: 'X1' }] }),
    );
    const result = await runPipeline(
      pipeline([
        {
          id: 't',
          kind: 'transform',
          ref: 'lift-scan-stats',
          transform: {
            source: { file: 'scan.json' },
            mappings: [
              { as: 'APP', path: 'app' },
              { as: 'CRITICAL', path: 'summary.critical' },
              { as: 'HIGH', path: 'summary.high' },
              { as: 'TOP_ID', path: 'findings.0.id' },
              { as: 'MEDIUM', path: 'summary.medium', default: '0' },
            ],
          },
        },
      ]),
      { dir, executors: stageExecutors },
    );
    expect(result.status).toBe('passed');
    expect(result.vars).toEqual({ APP: 'billing-svc', CRITICAL: '3', HIGH: '7', TOP_ID: 'X1', MEDIUM: '0' });
  });

  test('interpolates ${run.dir}/${VAR} in the source file path', async () => {
    await writeFile(resolve(dir, 'billing.json'), JSON.stringify({ ok: true }));
    const result = await runPipeline(
      pipeline([
        {
          id: 't',
          kind: 'transform',
          ref: 'by-var-path',
          transform: { source: { file: '${APP}.json' }, mappings: [{ as: 'OK', path: 'ok' }] },
        },
      ]),
      { dir, vars: { APP: 'billing' }, executors: stageExecutors },
    );
    expect(result.vars.OK).toBe('true');
  });

  test("parses a prior stage's JSON var (source.var) and threads result forward", async () => {
    const result = await runPipeline(
      pipeline([
        {
          id: 't',
          kind: 'transform',
          ref: 'from-var',
          transform: { source: { var: 'payload' }, mappings: [{ as: 'TOTAL', path: 'data.total' }] },
        },
      ]),
      { dir, vars: { payload: JSON.stringify({ data: { total: 99 } }) }, executors: stageExecutors },
    );
    expect(result.vars.TOTAL).toBe('99');
  });

  test('with no source, remaps over the live vars bag', async () => {
    const result = await runPipeline(
      pipeline([
        {
          id: 't',
          kind: 'transform',
          ref: 'rename',
          transform: { mappings: [{ as: 'RENAMED', path: 'original' }] },
        },
      ]),
      { dir, vars: { original: 'value-1' }, executors: stageExecutors },
    );
    expect(result.vars.RENAMED).toBe('value-1');
    expect(result.vars.original).toBe('value-1'); // original is preserved
  });

  test('an inline literal source is interpolated then parsed', async () => {
    const result = await runPipeline(
      pipeline([
        {
          id: 't',
          kind: 'transform',
          ref: 'inline',
          transform: {
            source: { inline: '{ "name": "${WHO}" }' },
            mappings: [{ as: 'NAME', path: 'name' }],
          },
        },
      ]),
      { dir, vars: { WHO: 'name' }, executors: stageExecutors },
    );
    expect(result.vars.NAME).toBe('name');
  });

  test('fails the stage (clear reason) when the source var is missing', async () => {
    const result = await runPipeline(
      pipeline([
        { id: 't', kind: 'transform', ref: 'bad', transform: { source: { var: 'nope' }, mappings: [{ as: 'X' }] } },
      ]),
      { dir, executors: stageExecutors },
    );
    expect(result.status).toBe('failed');
    expect(result.stages[0].error).toContain('source var not set: nope');
  });

  test('fails the stage on a bad JSON file rather than throwing', async () => {
    await writeFile(resolve(dir, 'broken.json'), '{ not json');
    const result = await runPipeline(
      pipeline([
        {
          id: 't',
          kind: 'transform',
          ref: 'bad-file',
          transform: { source: { file: 'broken.json' }, mappings: [{ as: 'X' }] },
        },
      ]),
      { dir, executors: stageExecutors },
    );
    expect(result.status).toBe('failed');
    expect(result.stages[0].error).toContain('transform source error');
  });

  test('refuses a source file that escapes the run dir', async () => {
    const result = await runPipeline(
      pipeline([
        {
          id: 't',
          kind: 'transform',
          ref: 'escape',
          transform: { source: { file: '../../etc/passwd' }, mappings: [{ as: 'X' }] },
        },
      ]),
      { dir, executors: stageExecutors },
    );
    expect(result.status).toBe('failed');
    expect(result.stages[0].error).toContain('escapes the run dir');
  });

  test('a missing transform spec fails with a clear message', async () => {
    const result = await runPipeline(pipeline([{ id: 't', kind: 'transform', ref: 'no-spec' }]), {
      dir,
      executors: stageExecutors,
    });
    expect(result.status).toBe('failed');
    expect(result.stages[0].error).toContain('missing `transform.mappings`');
  });
});
