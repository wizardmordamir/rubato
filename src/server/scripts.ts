/**
 * Execute a custom script — an in-process registered function or a discovered
 * `.ts` file — and report a StageOutcome. This is the seam both the standalone
 * "Scripts" run API and (next phase) the pipeline `script` stage call.
 *
 * Registered scripts run in-process with the run context. File scripts are spawned
 * with Bun (cwd = the per-run dir) so they execute with no build step, exactly like
 * every other rubato command. Either kind hands values forward through the vars
 * bag: a registered script returns `{ vars }`, a file script writes
 * `$RUBATO_RUN_DIR/outputs.json`.
 *
 * Trust model: running a script executes the user's own code by design. Scripts are
 * addressed by id (a registered id or a slug of a file we discovered by listing the
 * scripts dir), so a run request can't point execution at an arbitrary path. What a
 * script then does is unscoped — same trust model as the rest of the rubato CLI.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, OUTPUTS_DIR, RUBATO_HOME } from '../lib/config';
import { writeLatestOutput } from '../lib/runStore';
import { getRegisteredScript, listRegisteredScripts, type RegisteredScript } from '../lib/scriptRegistry';
import { getUserScript, loadUserScripts, type UserScript } from '../lib/userScripts';
import type { ScriptInfo, ScriptParamValues, StageOutcome, StageStatus } from '../shared/pipeline';
import { emit } from './events';

const MAX_OUTPUT = 64_000;
const DEFAULT_TIMEOUT = 30_000;
const RUNS_DIR = resolve(RUBATO_HOME, 'pipeline-runs');

export interface ScriptExecInput {
  /** The per-run working dir (shared across pipeline stages). Created if missing. */
  dir: string;
  vars: Record<string, string>;
  params: ScriptParamValues;
  /** Live log sink (each stdout/stderr chunk, or a registered script's log lines). */
  onLog?: (chunk: string) => void;
  /** Timeout override (ms) for a file script; falls back to its own / the default. */
  timeout?: number;
}

export interface ScriptExecResult {
  outcome: StageOutcome;
  output: string;
}

/** The merged catalog: registered scripts first, then discovered files (id wins). */
export async function listScripts(): Promise<ScriptInfo[]> {
  const seen = new Set<string>();
  const out: ScriptInfo[] = [];
  for (const s of listRegisteredScripts()) {
    seen.add(s.id);
    out.push({ id: s.id, name: s.name ?? s.id, description: s.description, params: s.params, source: 'registered' });
  }
  for (const s of await loadUserScripts()) {
    if (seen.has(s.id)) continue; // a registered script of the same id wins
    out.push({ id: s.id, name: s.name, description: s.description, params: s.params, source: 'file', file: s.file });
  }
  return out;
}

/** Pump a byte stream through a decoder, forwarding + accumulating decoded text. */
async function pump(stream: ReadableStream<Uint8Array>, sink: (s: string) => void): Promise<void> {
  const dec = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    sink(dec.decode(chunk, { stream: true }));
  }
}

/** Read a file script's optional `outputs.json` → the vars to merge forward. */
async function readOutputs(dir: string): Promise<Record<string, string> | undefined> {
  try {
    const raw = JSON.parse(await readFile(resolve(dir, 'outputs.json'), 'utf8')) as { vars?: Record<string, unknown> };
    if (!raw || typeof raw !== 'object' || typeof raw.vars !== 'object' || raw.vars === null) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.vars)) out[k] = String(v);
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

async function executeRegistered(
  def: RegisteredScript,
  input: ScriptExecInput,
  outputDir: string,
): Promise<ScriptExecResult> {
  const lines: string[] = [];
  const log = (m: string) => {
    lines.push(m);
    input.onLog?.(`${m}\n`);
  };
  try {
    const outcome = (await def.run({ dir: input.dir, outputDir, vars: input.vars, params: input.params, log })) ?? {
      status: 'passed' as const,
    };
    return { outcome, output: lines.join('\n') };
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`error: ${msg}`);
    return { outcome: { status: 'failed', detail: msg }, output: lines.join('\n') };
  }
}

async function executeFile(
  script: UserScript,
  input: ScriptExecInput,
  defaultTimeout: number,
  outputDir: string,
): Promise<ScriptExecResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [k, v] of Object.entries(input.vars)) env[k] = v;
  for (const [k, v] of Object.entries(input.params)) env[k] = String(v);
  env.RUBATO_RUN_DIR = input.dir;
  env.RUBATO_OUTPUT_DIR = outputDir;
  env.RUBATO_VARS = JSON.stringify(input.vars);
  env.RUBATO_PARAMS = JSON.stringify(input.params);

  const proc = Bun.spawn(['bun', 'run', script.file], {
    cwd: input.dir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  let output = '';
  const sink = (s: string) => {
    output += s;
    input.onLog?.(s);
  };

  const timeoutMs = input.timeout ?? script.timeout ?? defaultTimeout;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    await Promise.all([pump(proc.stdout, sink), pump(proc.stderr, sink)]);
    const exitCode = await proc.exited;
    if (timedOut) sink(`\n[script timed out after ${timeoutMs}ms]\n`);
    const vars = await readOutputs(input.dir);
    const status = !timedOut && exitCode === 0 ? 'passed' : 'failed';
    return { outcome: { status, vars, detail: { exitCode } }, output: output.slice(0, MAX_OUTPUT) };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a script id and run it, returning its outcome + captured output. */
export async function executeScriptById(id: string, input: ScriptExecInput): Promise<ScriptExecResult> {
  await mkdir(input.dir, { recursive: true });
  const cfg = await loadConfig();
  const registered = getRegisteredScript(id);
  if (registered) return executeRegistered(registered, input, OUTPUTS_DIR);
  const file = await getUserScript(id);
  if (file) return executeFile(file, input, cfg.automations?.timeout ?? DEFAULT_TIMEOUT, OUTPUTS_DIR);
  throw new Error(`unknown script: ${id}`);
}

/**
 * Turn a failed outcome's `detail` into a human-readable reason. Registered
 * scripts fail by returning `{ error: '…' }` (or a string / a richer object);
 * file scripts fail with just `{ exitCode }`, where the real reason is the
 * captured stderr — so an exit-code-only detail yields no reason here and we
 * lean on the captured output instead.
 */
function failureReason(detail: unknown): string {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail.trim();
  if (typeof detail === 'object') {
    const o = detail as Record<string, unknown>;
    if (typeof o.error === 'string') return o.error.trim();
    const keys = Object.keys(o);
    if (keys.length === 0 || (keys.length === 1 && keys[0] === 'exitCode')) return '';
    try {
      return JSON.stringify(o, null, 2);
    } catch {
      return '';
    }
  }
  return String(detail);
}

/**
 * Compose the self-describing body written to a script's output file (and shown
 * in the Files tab). A bare exit-code header told you a run failed but never why;
 * this leads with a status/timing/run-dir summary, surfaces the failure reason up
 * front when one is known, then the captured stdout/stderr (or a clear "no output
 * captured", so an empty failure isn't a mystery).
 */
function composeScriptOutput(opts: {
  status: StageStatus;
  durationMs: number;
  runDir: string;
  output: string;
  reason: string;
}): string {
  const { status, durationMs, runDir, output, reason } = opts;
  const parts = [`status: ${status} · ${durationMs}ms`, `run dir: ${runDir}`, ''];
  if (status === 'failed' && reason) parts.push('── why it failed ──', reason, '');
  parts.push('── output ──', output.trim() ? output.trimEnd() : '(no output captured)');
  return `${parts.join('\n')}\n`;
}

/**
 * Run a script standalone (the Scripts page / run API): make a per-run dir, stream
 * progress over /ws, capture the output into the output dir for the Files tab.
 */
export async function startScriptRun(
  id: string,
  opts: { vars?: Record<string, string>; params?: ScriptParamValues } = {},
): Promise<void> {
  const startedAt = Date.now();
  const dir = resolve(RUNS_DIR, `script-${id}-${startedAt}`);
  emit({ type: 'script:run:started', script: id, runDir: dir });
  try {
    const { outcome, output } = await executeScriptById(id, {
      dir,
      vars: opts.vars ?? {},
      params: opts.params ?? {},
      onLog: (chunk) => emit({ type: 'script:output', script: id, chunk }),
    });
    const exitCode = outcome.status === 'passed' ? 0 : 1;
    const durationMs = Date.now() - startedAt;
    const reason = outcome.status === 'failed' ? failureReason(outcome.detail) : '';
    // Surface the reason live too: many scripts fail by *returning* a detail
    // (e.g. "namespace is required …") without ever logging it, so without this
    // the output pane — and the saved file — would show only the exit code.
    if (reason) emit({ type: 'script:output', script: id, chunk: `\n${reason}\n` });
    const body = composeScriptOutput({ status: outcome.status, durationMs, runDir: dir, output, reason });
    const outputPath = await writeLatestOutput(`script-${id}`, [], exitCode, body, startedAt).catch(() => undefined);
    emit({ type: 'script:run:completed', script: id, status: outcome.status, outputPath, runDir: dir, durationMs });
  } catch (err) {
    // executeScriptById itself threw (unknown id, a mkdir failure, …). Persist it
    // to the output file too, so the failure is debuggable from the Files tab.
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const durationMs = Date.now() - startedAt;
    emit({ type: 'script:output', script: id, chunk: `error: ${msg}\n` });
    const body = composeScriptOutput({ status: 'failed', durationMs, runDir: dir, output: '', reason: msg });
    const outputPath = await writeLatestOutput(`script-${id}`, [], 1, body, startedAt).catch(() => undefined);
    emit({ type: 'script:run:completed', script: id, status: 'failed', outputPath, runDir: dir, durationMs });
  }
}
