/**
 * rubato-pipeline — run a saved pipeline headless from the terminal.
 *
 * Pipelines chain heterogeneous stages (automations, custom scripts) in sequence,
 * sharing a vars bag + a per-run working dir. Built/edited in the web UI
 * (rubato-serve → Pipelines) and stored as JSON under ~/.rubato/pipelines/. This
 * runs one by id or name, printing each stage as it completes, and records the run
 * alongside the UI's history. Required variables are taken from KEY=VALUE args.
 */

import { slugify } from '../lib/automations';
import { getPipeline, listPipelines } from '../lib/pipelines';
import { subscribe } from '../server/events';
import { missingPipelineVariables, startPipelineRun } from '../server/pipelines';

async function resolvePipeline(arg: string) {
  const direct = (await getPipeline(arg)) ?? (await getPipeline(slugify(arg)));
  if (direct) return direct;
  const all = await listPipelines();
  return all.find((p) => p.name.toLowerCase() === arg.toLowerCase()) ?? null;
}

/** Parse KEY=VALUE pairs from the args into a variables map. */
function parseVars(args: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const a of args) {
    if (a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) vars[a.slice(0, eq)] = a.slice(eq + 1);
  }
  return vars;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--') && !a.includes('='));

  if (!name || args.includes('--list')) {
    const all = await listPipelines();
    if (all.length === 0) {
      console.log('No pipelines yet — build one in the web UI (rubato-serve → Pipelines).');
    } else {
      console.log('Saved pipelines:');
      for (const p of all) console.log(`  ${p.id}  —  ${p.name} (${p.stages.length} stages)`);
    }
    return;
  }

  const pipeline = await resolvePipeline(name);
  if (!pipeline) {
    console.error(`No pipeline matching "${name}". Try: rubato-pipeline --list`);
    process.exit(1);
  }

  const vars = parseVars(args);
  const missing = await missingPipelineVariables(pipeline, vars);
  if (missing.length) {
    console.error(
      `Missing required variables: ${missing.join(', ')}. Pass as KEY=VALUE or set them in ~/.rubato/.env.`,
    );
    process.exit(1);
  }

  console.log(`Running pipeline "${pipeline.name}" (${pipeline.stages.length} stages)…\n`);
  const unsub = subscribe((e) => {
    if (e.type !== 'pipeline:stage' || e.status === 'running') return;
    const mark = e.status === 'passed' ? '✓' : e.status === 'failed' ? '✗' : '·';
    console.log(`${mark} ${e.label}`);
  });

  const run = await startPipelineRun(pipeline, vars);
  unsub();

  console.log(`\n${run.status === 'passed' ? 'PASSED' : 'FAILED'} in ${run.durationMs}ms`);
  console.log(`Run dir: ${run.dir}`);
  if (Object.keys(run.vars).length > 0) console.log('Vars:', JSON.stringify(run.vars, null, 2));
  process.exit(run.status === 'passed' ? 0 : 1);
}

if (import.meta.main) main();
