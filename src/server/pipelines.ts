/**
 * Server-side pipeline orchestration: make a per-run working dir, run the stages
 * through the pure runner with the concrete executors, stream lifecycle events
 * over /ws, and persist the run. Also computes a pipeline's required variables for
 * the preload form (union of each stage's automation vars + `with` placeholders).
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { optionalEnv } from '../api/env';
import { getAutomation } from '../lib/automations';
import { collectAutomationVars, extractVarNames } from '../lib/automationVars';
import { RUBATO_HOME } from '../lib/config';
import { startDiagnostics } from '../lib/diagnostics';
import { runPipeline } from '../lib/pipelineRunner';
import type { Pipeline, PipelineRunRecord, PipelineVariable } from '../shared/pipeline';
import { recordPipelineRun } from './db';
import { emit } from './events';
import { stageExecutors } from './stageExecutors';

const RUNS_DIR = resolve(RUBATO_HOME, 'pipeline-runs');

/** The variables a pipeline references, each flagged present-in-env (never value). */
export async function pipelineVariables(pipeline: Pipeline): Promise<PipelineVariable[]> {
  const sources = new Map<string, Set<string>>();
  const add = (name: string, source: string) => {
    const set = sources.get(name) ?? new Set<string>();
    set.add(source);
    sources.set(name, set);
  };

  for (const stage of pipeline.stages) {
    // `with` placeholders reference vars the whole pipeline must supply.
    for (const value of Object.values(stage.with ?? {})) {
      for (const name of extractVarNames(value)) add(name, 'with');
    }
    // An automation stage's own referenced vars (scripts are opaque at list time).
    if (stage.kind === 'automation') {
      const automation = await getAutomation(stage.ref);
      if (automation) for (const v of collectAutomationVars(automation)) for (const s of v.sources) add(v.name, s);
    }
    // An excel stage's input/output filenames may interpolate vars.
    if (stage.kind === 'excel' && stage.excel) {
      for (const name of [...extractVarNames(stage.excel.input), ...extractVarNames(stage.excel.output.file)]) {
        add(name, 'excel');
      }
    }
  }

  return [...sources.entries()]
    .map(([name, s]) => ({ name, present: optionalEnv(name) !== undefined, sources: [...s].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Names not resolvable from env and not supplied for this run. */
export async function missingPipelineVariables(
  pipeline: Pipeline,
  supplied: Record<string, string> | undefined,
): Promise<string[]> {
  return (await pipelineVariables(pipeline))
    .filter((v) => !v.present && !supplied?.[v.name]?.length)
    .map((v) => v.name);
}

/** Run a pipeline end-to-end: per-run dir, streamed stages, persisted result. */
export async function startPipelineRun(
  pipeline: Pipeline,
  variables?: Record<string, string>,
): Promise<PipelineRunRecord> {
  const startedAt = Date.now();
  const dir = resolve(RUNS_DIR, `${pipeline.id}-${startedAt}`);
  await mkdir(dir, { recursive: true });
  emit({ type: 'pipeline:run:started', pipeline: pipeline.name, dir });

  // One diagnostic per pipeline run: per-stage steps + any failures, exportable.
  const diag = startDiagnostics({
    activity: `pipeline-${pipeline.id}`,
    intent: `run pipeline "${pipeline.name}"`,
    console: false,
  });
  diag.step('started', { pipeline: pipeline.name, dir, stages: pipeline.stages.length });

  const { status, stages, vars } = await runPipeline(pipeline, {
    dir,
    vars: variables,
    executors: stageExecutors,
    onStage: (p) => {
      if (p.status === 'failed') diag.warn(`stage failed: ${p.label}`, { stageId: p.stageId, kind: p.kind });
      else if (p.status !== 'running') diag.step(`stage ${p.status}: ${p.label}`, { stageId: p.stageId, kind: p.kind });
      emit({
        type: 'pipeline:stage',
        pipeline: pipeline.name,
        stageId: p.stageId,
        label: p.label,
        kind: p.kind,
        status: p.status,
      });
    },
  });

  // The runner returns per-stage errors in `stages`; surface them in the report.
  for (const s of stages)
    if (s.status === 'failed' && s.error) diag.error(`stage error: ${s.label}`, { error: s.error });
  const { reportPath } = await diag.finish(status === 'failed' ? 'error' : 'ok');

  const run = recordPipelineRun({
    pipeline: pipeline.name,
    status,
    stages,
    vars,
    dir,
    diagnosticPath: reportPath,
    startedAt,
    durationMs: Date.now() - startedAt,
  });
  emit({ type: 'pipeline:run:completed', run });
  return run;
}
