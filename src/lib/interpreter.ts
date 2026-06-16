/**
 * The automation interpreter: walks an Automation's steps and drives a browser
 * through a BrowserDriver (control flow, interpolation, conditionals, the scrape
 * bag, and step-result streaming all live here — testable without a real
 * browser). The driver itself is the only Playwright-touching piece, implemented
 * over the Node host in src/server/browserHost.ts.
 */

import type {
  ActionOutcome,
  ActionType,
  Automation,
  Condition,
  LeafAction,
  Step,
  StepParams,
  StepResult,
  Target,
} from '../shared/automation';
import { interpolate, redact, resolveEnvVar } from './interpolate';
import { targetToSelectorString } from './locator';
import { normalizeUrl } from './url';

/** The browser operations the interpreter needs. Implemented by the Node host. */
export interface BrowserDriver {
  /** Run one action. `capture` asks the host to also grab a frame (HTML +
   *  screenshot) of the resulting page, returned on the outcome — used to build a
   *  per-step timeline (the interpreter decides which steps via ctx.captureFrame). */
  exec(
    action: LeafAction,
    target: Target | undefined,
    params: StepParams,
    timeout?: number,
    capture?: boolean,
  ): Promise<ActionOutcome>;
  condition(cond: Condition, timeout?: number): Promise<boolean>;
}

export interface RunContext {
  /** name → value, accumulated by `scrape` steps and read via ${scraped.NAME}. */
  scraped: Record<string, string>;
  /**
   * name → value supplied for this run (preload form / pipeline vars bag),
   * consulted before env when resolving ${VAR} and `valueMode:"env"` steps.
   */
  vars?: Record<string, string>;
  /** The per-run working directory, exposed to steps as ${run.dir}. */
  dir?: string;
  /** Live callback for each step (emitted as "running" then a final status). */
  emit: (result: StepResult) => void;
  /**
   * Optional gate consulted BEFORE each step runs (including the implicit start
   * `goto`). Powers run-time pacing (resolve after a delay to slow a run so it can
   * be watched) and the live step-through executor (block until "next"/"play",
   * return "abort" to stop). `prevAction` is the action that just ran, so a pacer
   * can vary the delay (tiny after typing, longer after a click/navigation).
   * Absent ⇒ steps run back-to-back at full speed (today's behavior).
   */
  beforeStep?: (info: { index: string; step: Step; prevAction?: ActionType }) => Promise<'go' | 'abort'>;
  /**
   * Optional: should a frame (HTML + screenshot) be captured after this action?
   * When true and the host returned a frame on the outcome, it's persisted via
   * `saveArtifact` just like a `snapshot`, so a run builds a per-step timeline.
   * Absent ⇒ only `snapshot`/failed steps capture (today's behavior).
   */
  captureFrame?: (action: LeafAction) => boolean;
  /** Optional: resolve a file path for a screenshot step at the given index. */
  screenshotPath?: (index: string) => string | undefined;
  /**
   * Optional: persist content to disk for a `saveFile` step. `path` is the
   * user's (interpolated) path, possibly empty/relative; the implementation
   * resolves it and returns the absolute path actually written.
   */
  writeFile?: (path: string, content: string) => Promise<string>;
  /**
   * Optional: persist a step's captured HTML / screenshot (a `snapshot` step, or
   * the page state at the moment a step failed) to files under the output dir.
   * `label` names a snapshot. Returns the saved files' paths (relative to the
   * output dir) so the run record points at them. Absent (build session / tests)
   * ⇒ captures stay inline on the result instead.
   */
  saveArtifact?: (
    index: string,
    captures: { html?: string; screenshot?: string },
    label?: string,
  ) => Promise<{ htmlPath?: string; screenshotPath?: string }>;
}

export interface RunOutcome {
  status: 'passed' | 'failed';
  steps: StepResult[];
  scraped: Record<string, string>;
}

const MAX_DEPTH = 25;

/** Actions that act on a specific element and so need a `target` (else there's
 *  nothing to click/fill/assert against). `waitFor` only needs one for the
 *  element-state waits (visible/hidden), not the page-level ones (load/networkidle). */
const TARGET_REQUIRED: ReadonlySet<LeafAction> = new Set([
  'click',
  'hover',
  'fill',
  'select',
  'check',
  'uncheck',
  'setFiles',
  'scrape',
  'expectText',
  'expectVisible',
  'expectHidden',
  'expectEnabled',
  'expectDisabled',
  'expectValue',
  'expectAttribute',
  'expectCount',
]);

/** Does this action need a target element to act on? */
export function actionNeedsTarget(action: LeafAction, params?: StepParams): boolean {
  if (action === 'waitFor') return params?.waitKind === 'visible' || params?.waitKind === 'hidden';
  return TARGET_REQUIRED.has(action);
}

/**
 * Turn a raw locator failure (a Playwright timeout / not-found, which reads as a
 * wall of call-log text) into a clear, actionable line that names what couldn't
 * be found — the difference between "it stopped and I don't know why" and "the
 * input field for step 2 wasn't found, re-pick it". Non-element errors and errors
 * that don't look like a missing element pass through unchanged.
 */
export function describeActionFailure(
  action: LeafAction,
  selector: string | undefined,
  raw: string,
  timeoutMs?: number,
): string {
  const looksLikeNotFound =
    /timeout.*exceeded|waiting for (the )?(locator|selector|element)|not (visible|found|attached|enabled)|strict mode violation|resolved to \d+ element/i.test(
      raw,
    );
  if (!selector || !looksLikeNotFound) return raw;
  const waited = timeoutMs ? ` within ${Math.round(timeoutMs / 1000)}s` : '';
  return `Could not find the element to ${action} (${selector})${waited}. The page may differ from when this step was captured, or the selector now matches nothing (or more than one element). Re-pick the element for this step, or add a wait before it.\n\nDetails: ${raw}`;
}

/**
 * Extract a substring from scraped text with a regex. `pattern` is a bare regex or
 * a `/pattern/flags` literal; the first capture group is returned if present, else
 * the whole match, else '' for no match. An empty pattern returns the text as-is.
 * Throws on an invalid pattern (the scrape step then fails with a clear message).
 */
export function extractWithRegex(text: string, pattern: string | undefined): string {
  if (!pattern) return text;
  const literal = pattern.match(/^\/(.*)\/([a-z]*)$/s);
  const re = literal ? new RegExp(literal[1], literal[2]) : new RegExp(pattern);
  const match = re.exec(text);
  return match ? (match[1] ?? match[0]) : '';
}

/** Thrown to abort the run when a required step fails. */
class StepFailure extends Error {
  constructor(public result: StepResult) {
    super(result.error ?? 'step failed');
  }
}

/** Thrown to unwind the run when `beforeStep` returns "abort" (live-step stop). */
class RunAborted extends Error {}

/** Mutable per-run cursor shared across the (recursive) step walk. */
interface RunState {
  /** The action that most recently executed, for the pacer/gate. */
  prevAction?: ActionType;
  /** Set once any required step failed, so an abort still reports the failure. */
  failed?: boolean;
}

export async function runAutomation(
  driver: BrowserDriver,
  automation: Automation,
  ctx: RunContext,
): Promise<RunOutcome> {
  const steps: StepResult[] = [];
  const record = (r: StepResult) => {
    steps.push(r);
    ctx.emit(r);
  };
  const state: RunState = {};
  const verdict = (status: RunOutcome['status']): RunOutcome => ({ status, steps, scraped: ctx.scraped });

  try {
    if (automation.startUrl) {
      const start: Step = { id: 'start', action: 'goto', params: { url: automation.startUrl } };
      await gate(ctx, state, 'start', start);
      const r = await runLeaf(driver, ctx, 'start', start);
      record(r);
      state.prevAction = 'goto';
      if (r.status === 'failed') throw new StepFailure(r);
    }
    await runSteps(driver, automation.steps, '', ctx, record, 0, state);
    return verdict(state.failed ? 'failed' : 'passed');
  } catch (e) {
    if (e instanceof StepFailure) return verdict('failed');
    // A user-aborted live-step session ends with whatever ran so far.
    if (e instanceof RunAborted) return verdict(state.failed ? 'failed' : 'passed');
    throw e;
  }
}

/** Consult `beforeStep` (pacing / live-step gate); throw RunAborted on "abort". */
async function gate(ctx: RunContext, state: RunState, index: string, step: Step): Promise<void> {
  if (!ctx.beforeStep) return;
  const verdict = await ctx.beforeStep({ index, step, prevAction: state.prevAction });
  if (verdict === 'abort') throw new RunAborted();
}

async function runSteps(
  driver: BrowserDriver,
  list: Step[],
  prefix: string,
  ctx: RunContext,
  record: (r: StepResult) => void,
  depth: number,
  state: RunState,
): Promise<void> {
  if (depth > MAX_DEPTH) throw new Error('automation nesting too deep');
  for (let i = 0; i < list.length; i++) {
    const step = list[i];
    const index = prefix ? `${prefix}.${i}` : String(i);

    await gate(ctx, state, index, step);

    if (step.action === 'if') {
      ctx.emit(running(step, index));
      const matched = await driver.condition(step.condition ?? { kind: 'url-matches', value: '' }).catch(() => false);
      record({ ...base(step, index), status: 'passed', selector: `if → ${matched ? 'then' : 'else'}`, durationMs: 0 });
      state.prevAction = 'if';
      const branch = matched ? step.thenSteps : step.elseSteps;
      if (branch?.length) {
        await runSteps(driver, branch, `${index}.${matched ? 'then' : 'else'}`, ctx, record, depth + 1, state);
      }
      continue;
    }

    ctx.emit(running(step, index));
    const r = await runLeaf(driver, ctx, index, step);
    record(r);
    state.prevAction = step.action;
    if (r.status === 'failed' && !step.options?.optional) {
      state.failed = true;
      throw new StepFailure(r);
    }
  }
}

async function runLeaf(driver: BrowserDriver, ctx: RunContext, index: string, step: Step): Promise<StepResult> {
  const started = nowMs();
  const action = step.action as LeafAction;
  const selector = step.target ? targetToSelectorString(step.target) : undefined;

  // Interpolate the user-facing string params; collect any secrets to redact.
  const params: StepParams = { ...step.params };
  const secrets: string[] = [];

  // `value` honors its mode: an env-var NAME ("env"), or a masked literal
  // ("secret") that is still interpolated but always kept out of logs.
  if (typeof params.value === 'string') {
    if (params.valueMode === 'env') {
      const { value } = resolveEnvVar(params.value, ctx.vars);
      params.value = value;
      if (value) secrets.push(value);
    } else {
      if (params.value.includes('${')) {
        const { value, redacted } = interpolate(params.value, ctx);
        params.value = value;
        if (redacted && value) secrets.push(value);
      }
      if (params.valueMode === 'secret' && params.value) secrets.push(params.value);
    }
  }
  for (const key of ['url', 'path'] as const) {
    const raw = params[key];
    if (typeof raw === 'string' && raw.includes('${')) {
      const { value, redacted } = interpolate(raw, ctx);
      params[key] = value;
      if (redacted && value) secrets.push(value);
    }
  }
  if (action === 'screenshot' && !params.path) params.path = ctx.screenshotPath?.(index);
  // goto/newTab need a scheme or Playwright rejects it ("invalid URL" → blank page).
  if (action === 'goto' || action === 'newTab') {
    const raw = params.url ?? params.value;
    if (raw) params.url = normalizeUrl(raw);
  }

  // Nothing to act on → fail (or skip, if optional) with a clear, actionable
  // reason instead of the host's cryptic null deref on `loc.first()`. This is the
  // common "a captured step lost its element" case (e.g. a fill with no input picked).
  if (actionNeedsTarget(action, params) && !step.target) {
    return {
      ...base(step, index),
      status: step.options?.optional ? 'skipped' : 'failed',
      selector,
      error: `This “${action}” step has no target element to act on — open the step and pick the element (for a fill, the input field to type into).`,
      durationMs: nowMs() - started,
    };
  }

  // Ask the host for a per-step frame on the actions worth a screenshot (the
  // ctx decides which — see pacing.capturesFrame). saveFile is host-free.
  const wantFrame = action !== 'saveFile' && (ctx.captureFrame?.(action) ?? false);
  try {
    // saveFile is a host-free side effect: write the (interpolated) content — or
    // the whole scrape bag as JSON when no content was given — through ctx.writeFile.
    const out =
      action === 'saveFile'
        ? { path: await writeStepFile(ctx, params) }
        : await driver.exec(action, step.target, params, step.options?.timeout, wantFrame);
    const result: StepResult = {
      ...base(step, index),
      status: 'passed',
      selector,
      matchCount: out.matchCount,
      durationMs: nowMs() - started,
      finalUrl: out.finalUrl,
      logs: out.logs?.length ? out.logs : undefined,
      network: out.network?.length ? out.network : undefined,
    };
    if (action === 'scrape' && step.params?.saveAs) {
      // Optionally narrow the captured text to a regex match (e.g. grab the sha256
      // digest out of a multi-line block). Invalid pattern → throws → step fails.
      const value = extractWithRegex(out.value ?? '', params.regex);
      ctx.scraped[step.params.saveAs] = value;
      result.scraped = { name: step.params.saveAs, value };
    }
    if ((action === 'screenshot' || action === 'saveFile') && out.path) result.selector = out.path;
    // A snapshot step captures HTML + a screenshot; persist them as files. The
    // same persistence also runs for any meaningful step when per-step capture is
    // on (ctx.captureFrame) and the host returned a frame — building a per-step
    // timeline (screenshot/HTML per step), not just for snapshots/failures.
    if (action === 'snapshot') {
      Object.assign(
        result,
        await persistCaptures(ctx, index, { html: out.html, screenshot: out.screenshot }, params.value),
      );
    } else if (wantFrame && (out.html || out.screenshot)) {
      Object.assign(result, await persistCaptures(ctx, index, { html: out.html, screenshot: out.screenshot }));
    }
    return result;
  } catch (e) {
    let error = e instanceof Error ? e.message : String(e);
    // Make a locator timeout/not-found legible ("could not find the input field…").
    error = describeActionFailure(action, selector, error, step.options?.timeout);
    for (const secret of secrets) error = redact(error, secret);
    // A host action failure carries diagnostics (final URL, logs, and the page
    // state — a screenshot + HTML — at the moment it broke).
    const diag = (e as { outcome?: ActionOutcome }).outcome;
    const captures = await persistCaptures(
      ctx,
      index,
      { html: diag?.html, screenshot: diag?.screenshot },
      params.value,
    );
    return {
      ...base(step, index),
      status: step.options?.optional ? 'skipped' : 'failed',
      selector,
      error,
      durationMs: nowMs() - started,
      finalUrl: diag?.finalUrl,
      logs: diag?.logs?.length ? diag.logs : undefined,
      ...captures,
    };
  }
}

/**
 * Persist a step's captured HTML / screenshot to files (when the run has an
 * output dir) and return the result fields pointing at them. Without a
 * `saveArtifact` seam (build session / tests) the screenshot stays inline as a
 * data: URL so it's still visible, and the HTML is dropped (nowhere to put it).
 */
async function persistCaptures(
  ctx: RunContext,
  index: string,
  captures: { html?: string; screenshot?: string },
  label?: string,
): Promise<Pick<StepResult, 'screenshot' | 'screenshotPath' | 'htmlPath'>> {
  if (!captures.html && !captures.screenshot) return {};
  if (ctx.saveArtifact) {
    const saved = await ctx
      .saveArtifact(index, captures, label)
      .catch((): { htmlPath?: string; screenshotPath?: string } => ({}));
    return { htmlPath: saved.htmlPath, screenshotPath: saved.screenshotPath };
  }
  return captures.screenshot ? { screenshot: captures.screenshot } : {};
}

/** Write a `saveFile` step's content (or the scrape bag as JSON) and return the path. */
async function writeStepFile(ctx: RunContext, params: StepParams): Promise<string> {
  if (!ctx.writeFile) throw new Error("saving to a file isn't available in this run context");
  const content = params.value && params.value.length > 0 ? params.value : `${JSON.stringify(ctx.scraped, null, 2)}\n`;
  return ctx.writeFile(params.path ?? '', content);
}

function base(step: Step, index: string) {
  return { stepId: step.id, index, action: step.action } as const;
}

function running(step: Step, index: string): StepResult {
  return { ...base(step, index), status: 'running', durationMs: 0 };
}

function nowMs(): number {
  return Date.now();
}
