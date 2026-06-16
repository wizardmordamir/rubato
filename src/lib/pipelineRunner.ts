/**
 * The pipeline runner — pure orchestration with stage executors injected (the same
 * seam style as the deploy engine). It owns the cross-stage contract: a shared vars
 * bag that flows forward and a per-run working directory that files hand off
 * through. It knows nothing about Playwright, scripts, or the DB — the server wires
 * concrete executors in (src/server/stageExecutors.ts) and persists the result.
 *
 * Stages run in order. Each stage's `with` overrides are interpolated (against the
 * current vars + ${run.dir}) and layered over the bag for that stage only; whatever
 * the stage *returns* as vars is merged into the shared bag for later stages. A
 * failed stage hard-stops the pipeline unless it's marked continueOnError.
 */

import type { Pipeline, PipelineStage, PipelineStageKind, PipelineStageResult, StageOutcome } from '../shared/pipeline';
import { interpolate } from './interpolate';

/** What an executor receives: the run dir + the effective vars for this stage. */
export interface PipelineRunContext {
  dir: string;
  vars: Record<string, string>;
}

export interface StageExecutor {
  /** Run the stage; `log` streams output the runner captures into the result. */
  run(stage: PipelineStage, ctx: PipelineRunContext, log: (chunk: string) => void): Promise<StageOutcome>;
}

export type StageExecutorMap = Partial<Record<PipelineStageKind, StageExecutor>>;

export interface StageProgress {
  stageId: string;
  kind: PipelineStageKind;
  label: string;
  status: 'running' | 'passed' | 'failed' | 'skipped';
}

export interface RunPipelineOptions {
  /** The per-run working dir (already created by the caller). */
  dir: string;
  /** Seed vars (preload form). The bag grows as stages declare outputs. */
  vars?: Record<string, string>;
  executors: StageExecutorMap;
  /** Stage lifecycle callback ("running" then a terminal status). */
  onStage?: (p: StageProgress) => void;
}

export interface PipelineRunResult {
  status: 'passed' | 'failed';
  stages: PipelineStageResult[];
  vars: Record<string, string>;
}

function labelFor(stage: PipelineStage): string {
  return stage.label?.trim() || `${stage.kind}:${stage.ref}`;
}

/** Resolve a stage's `with` overrides against the current bag + run dir. */
function resolveWith(stage: PipelineStage, vars: Record<string, string>, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(stage.with ?? {})) {
    out[k] = interpolate(v, { scraped: {}, vars, dir }).value;
  }
  return out;
}

export async function runPipeline(pipeline: Pipeline, opts: RunPipelineOptions): Promise<PipelineRunResult> {
  const vars: Record<string, string> = { ...(opts.vars ?? {}) };
  const stages: PipelineStageResult[] = [];

  for (const stage of pipeline.stages) {
    const label = labelFor(stage);
    opts.onStage?.({ stageId: stage.id, kind: stage.kind, label, status: 'running' });
    const started = Date.now();
    const logs: string[] = [];
    const log = (chunk: string) => logs.push(chunk);

    let result: PipelineStageResult;
    const executor = opts.executors[stage.kind];
    if (!executor) {
      result = base(stage, label, 'failed', started, { error: `no executor for stage kind: ${stage.kind}` });
    } else {
      try {
        const stageVars = { ...vars, ...resolveWith(stage, vars, opts.dir) };
        const outcome = await executor.run(stage, { dir: opts.dir, vars: stageVars }, log);
        if (outcome.vars) Object.assign(vars, outcome.vars);
        result = base(stage, label, outcome.status, started, {
          output: logs.join('') || undefined,
          vars: outcome.vars,
          error: outcome.status === 'failed' ? detailToError(outcome.detail) : undefined,
        });
      } catch (err) {
        result = base(stage, label, 'failed', started, {
          output: logs.join('') || undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    stages.push(result);
    opts.onStage?.({ stageId: stage.id, kind: stage.kind, label, status: result.status });
    if (result.status === 'failed' && !stage.continueOnError) break;
  }

  const status = stages.some((s) => s.status === 'failed') ? 'failed' : 'passed';
  return { status, stages, vars };
}

function base(
  stage: PipelineStage,
  label: string,
  status: PipelineStageResult['status'],
  started: number,
  extra: Partial<PipelineStageResult>,
): PipelineStageResult {
  return {
    stageId: stage.id,
    kind: stage.kind,
    ref: stage.ref,
    label,
    status,
    durationMs: Date.now() - started,
    ...extra,
  };
}

function detailToError(detail: unknown): string | undefined {
  if (detail == null) return undefined;
  return typeof detail === 'string' ? detail : undefined;
}
