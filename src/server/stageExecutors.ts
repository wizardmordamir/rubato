/**
 * Concrete pipeline stage executors — the impure seam that wires the existing
 * engines into the pure runner (src/lib/pipelineRunner.ts), one per stage kind:
 *   - automation → the Playwright engine, sharing the pipeline's run dir so a
 *     `saveFile` step lands a file later stages pick up; outputs = scraped vars.
 *   - script     → the custom-function executor (registered fn or .ts file);
 *     outputs = its declared vars (registered return / outputs.json).
 *   - excel      → a saved Excel/CSV transform over the run dir; outputs = the
 *     result row count + the output filename.
 *   - transform  → declarative cross-step data mapping (no engine): read a JSON
 *     source (a file in the run dir / a var / inline / the vars bag) and map
 *     dot-path fields into named vars. The pure logic is in lib/transformStage.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { getAutomation } from '../lib/automations';
import { interpolate } from '../lib/interpolate';
import type { PipelineRunContext, StageExecutor, StageExecutorMap } from '../lib/pipelineRunner';
import { applyMappings } from '../lib/transformStage';
import type { TransformSource } from '../shared/pipeline';
import { runAutomationHeadless } from './engine';
import { runAutomationOverFile } from './excelAutomation/runOverFile';
import { getAutomationRow, mapAutomation } from './excelAutomation/store';
import { executeScriptById } from './scripts';

const automationExecutor: StageExecutor = {
  async run(stage, ctx, log) {
    const automation = await getAutomation(stage.ref);
    if (!automation) return { status: 'failed', detail: `automation not found: ${stage.ref}` };
    // Share the pipeline run dir + vars; the automation's own events still stream.
    const run = await runAutomationHeadless(automation, { headless: true, variables: ctx.vars, dir: ctx.dir });
    log(`automation "${automation.name}": ${run.status} — ${run.steps.length} step(s)`);
    return { status: run.status, vars: run.scraped, detail: run.steps };
  },
};

const scriptExecutor: StageExecutor = {
  async run(stage, ctx, log) {
    const { outcome } = await executeScriptById(stage.ref, { dir: ctx.dir, vars: ctx.vars, params: {}, onLog: log });
    return { status: outcome.status, vars: outcome.vars };
  },
};

const excelExecutor: StageExecutor = {
  async run(stage, ctx, log) {
    const row = getAutomationRow(stage.ref);
    if (!row) return { status: 'failed', detail: `excel automation not found: ${stage.ref}` };
    if (!stage.excel?.input || !stage.excel.output?.file) {
      return { status: 'failed', detail: 'excel stage is missing input/output (set them on the stage)' };
    }
    const { name, steps } = mapAutomation(row);
    const r = await runAutomationOverFile({ name, steps }, stage.excel, { dir: ctx.dir, vars: ctx.vars, log });
    return { status: 'passed', vars: { rows: String(r.rows), outFile: r.outFile } };
  },
};

/**
 * Resolve a transform stage's source to a parsed value. Precedence: file → var →
 * inline → (nothing set) the vars bag itself. A `file` path is interpolated and
 * resolved INSIDE the run dir (a traversal outside it is refused). Throws with a
 * clear message on a missing var / unreadable file / bad JSON — the executor
 * turns that into a failed stage.
 */
async function resolveTransformSource(
  source: TransformSource | undefined,
  ctx: PipelineRunContext,
  interp: (s: string) => string,
): Promise<unknown> {
  if (source?.file) {
    const path = resolve(ctx.dir, interp(source.file));
    const rel = relative(ctx.dir, path);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`source file escapes the run dir: ${source.file}`);
    }
    return JSON.parse(await readFile(path, 'utf8'));
  }
  if (source?.var) {
    const raw = ctx.vars[source.var];
    if (raw == null) throw new Error(`source var not set: ${source.var}`);
    return JSON.parse(raw);
  }
  if (source?.inline) return JSON.parse(interp(source.inline));
  // No source declared → map over the live vars bag (rename/remap existing vars).
  return { ...ctx.vars };
}

const transformExecutor: StageExecutor = {
  async run(stage, ctx, log) {
    const spec = stage.transform;
    if (!spec || !Array.isArray(spec.mappings)) {
      return { status: 'failed', detail: 'transform stage is missing `transform.mappings`' };
    }
    const interp = (s: string) => interpolate(s, { scraped: {}, vars: ctx.vars, dir: ctx.dir }).value;
    let source: unknown;
    try {
      source = await resolveTransformSource(spec.source, ctx, interp);
    } catch (err) {
      return {
        status: 'failed',
        detail: `transform source error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const vars = applyMappings(source, spec.mappings, interp);
    const names = Object.keys(vars);
    log(`transform: set ${names.length} var(s)${names.length ? `: ${names.join(', ')}` : ''}`);
    return { status: 'passed', vars };
  },
};

/** The default executor map handed to the runner for a real pipeline run. */
export const stageExecutors: StageExecutorMap = {
  automation: automationExecutor,
  script: scriptExecutor,
  excel: excelExecutor,
  transform: transformExecutor,
};
