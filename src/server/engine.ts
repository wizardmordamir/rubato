/**
 * Run a saved automation headless. The headless analogue of run.ts: it spawns a
 * fresh Node browser host, drives it through the shared interpreter, streams each
 * step over the event bus (/ws), and records the run to SQLite. Screenshots land
 * under the configured output dir so they survive the run.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { RUBATO_HOME } from '../lib/config';
import { currentCorrelationId } from '../lib/correlation';
import { startDiagnostics } from '../lib/diagnostics';
import { runAutomation } from '../lib/interpreter';
import { ensureOutputDir } from '../lib/runStore';
import type { Automation, AutomationRunRecord, StepResult } from '../shared/automation';
import { capturesFrame, type RunSpeed, smartWaitMs } from '../shared/pacing';
import { BrowserHost } from './browserHost';
import { recordAutomationRun } from './db';
import { setCaptureEnabled } from './debugCapture';
import { emit } from './events';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SHOTS_DIR = resolve(RUBATO_HOME, 'automation-shots');
// Per-run working directories. Each run gets its own ${run.dir} so files handed
// off between steps (and, later, between pipeline stages) never collide — this is
// the keystone the Excel/script stages read & write through.
const RUNS_DIR = resolve(RUBATO_HOME, 'pipeline-runs');

/**
 * Resolve a `saveFile` target path and write it. Absolute paths (and ~) are
 * honoured as-is; relative or blank paths land under the per-run dir (so the
 * default location is the shared handoff dir). Returns the absolute path written.
 */
async function writeAutomationFile(
  automation: Automation,
  runDir: string,
  startedAt: number,
  p: string,
  content: string,
): Promise<string> {
  const raw = p.trim();
  const expanded = raw.startsWith('~/') ? resolve(homedir(), raw.slice(2)) : raw;
  const target = !expanded
    ? resolve(runDir, `${automation.id}-${startedAt}.json`)
    : isAbsolute(expanded)
      ? expanded
      : resolve(runDir, expanded);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

/** A data: URL → its raw bytes + a file extension (png/jpg/bin). */
function decodeDataUrl(dataUrl: string): { bytes: Buffer; ext: string } | null {
  const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] ?? 'application/octet-stream';
  const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'bin';
  return { bytes, ext };
}

/** Filesystem-safe single segment for an artifact filename. */
function slug(s: string): string {
  return s
    .replace(/\W+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Persist a step's captured HTML / screenshot (a `snapshot` step, or the page
 * state at the moment a step failed) to files under the output dir, and return
 * their paths relative to it — the run record points at them, and the web UI
 * loads them via /api/files/raw. Kept under the output dir so the existing,
 * scoped Files endpoints serve them with no extra access surface.
 */
async function saveRunArtifact(
  automation: Automation,
  startedAt: number,
  outputDir: string,
  index: string,
  captures: { html?: string; screenshot?: string },
  label?: string,
): Promise<{ htmlPath?: string; screenshotPath?: string }> {
  const dir = resolve(outputDir, 'automation-runs', `${automation.id}-${startedAt}`);
  await mkdir(dir, { recursive: true });
  const stem = [slug(index) || 'step', label ? slug(label) : ''].filter(Boolean).join('-');
  const out: { htmlPath?: string; screenshotPath?: string } = {};
  if (captures.html) {
    const abs = resolve(dir, `${stem}.html`);
    await writeFile(abs, captures.html, 'utf8');
    out.htmlPath = relative(outputDir, abs);
  }
  if (captures.screenshot) {
    const decoded = decodeDataUrl(captures.screenshot);
    if (decoded) {
      const abs = resolve(dir, `${stem}.${decoded.ext}`);
      await writeFile(abs, decoded.bytes);
      out.screenshotPath = relative(outputDir, abs);
    }
  }
  return out;
}

/**
 * A browser kept alive after a *headed* run failed, so the user can inspect the
 * page that broke. Only one is ever held; a new run (or an explicit close) tears
 * down the previous one. Never leaks past server exit (see the handlers below).
 */
let heldHost: BrowserHost | null = null;

/** Close the browser held open from a failed headed run, if any. */
export async function closeHeldBrowser(): Promise<void> {
  if (!heldHost) return;
  const host = heldHost;
  heldHost = null;
  await host.close().catch(() => {});
  host.kill();
}

/**
 * Hold a headed browser open after a run (keepOpen, or a failure worth
 * inspecting) and arm a close-detector: if the user shuts that window, tell the
 * UI to drop its "browser kept open" banner. An intentional teardown
 * (closeHeldBrowser) nulls heldHost first, so its own exit won't fire this.
 */
function holdBrowser(host: BrowserHost, automation: string): void {
  heldHost = host;
  const onClosed = () => {
    if (heldHost !== host) return; // we tore it down ourselves — not a user close
    heldHost = null;
    emit({ type: 'automation:browser:closed', automation });
  };
  host.onExit = onClosed;
  // If it already vanished between the alive check above and arming, fire now.
  if (!host.alive) onClosed();
}

/** Execute an automation end-to-end, recording and broadcasting the result. */
export async function runAutomationHeadless(
  automation: Automation,
  opts: {
    headless?: boolean;
    keepOpen?: boolean;
    speed?: RunSpeed;
    variables?: Record<string, string>;
    dir?: string;
  } = {},
): Promise<AutomationRunRecord> {
  const startedAt = Date.now();
  const headless = opts.headless ?? true;
  const speed: RunSpeed = opts.speed ?? 'off';
  // Tie this run to the request that launched it, and ensure outbound API/DB calls
  // are recorded — so its server logs + calls are retrievable by correlation id.
  const correlationId = currentCorrelationId();
  setCaptureEnabled(true);
  // keepOpen only makes sense headed: hold the browser open even on success.
  const keepOpen = !headless && (opts.keepOpen ?? false);
  emit({ type: 'automation:run:started', automation: automation.name });

  const host = new BrowserHost();
  const steps: StepResult[] = [];
  // We keep `host` open for inspection when a headed run fails, or whenever the
  // user asked to keep it open (keepOpen).
  let hold = false;
  // One diagnostic per automation run — captures each step and, crucially, the
  // host/launch error (or a setup failure) that the catch below otherwise swallows.
  let diag: ReturnType<typeof startDiagnostics> | undefined;

  // Everything from here is guarded. Once `automation:run:started` is emitted we
  // MUST emit `automation:run:completed` or the UI's Run button hangs on
  // "Running…" forever. The setup below (clear a held browser, make the run dirs,
  // resolve the output dir) used to live OUTSIDE the try, so a throw there — or a
  // host/launch failure — escaped before completion was ever reported. It now
  // lands in the catch, which records a failed run and completes.
  try {
    diag = startDiagnostics({
      activity: `automation-${automation.id}`,
      intent: `run automation "${automation.name}"`,
      console: false,
    });
    diag.step('started', { automation: automation.name, headless });

    // A previously held headed run may still be on screen — clear it before this one.
    await closeHeldBrowser();
    await mkdir(SHOTS_DIR, { recursive: true });
    // Use the caller's working dir (a pipeline shares one across stages) or make a
    // fresh per-run one. Exposed to steps as ${run.dir}.
    const runDir = opts.dir ?? resolve(RUNS_DIR, `${automation.id}-${startedAt}`);
    await mkdir(runDir, { recursive: true });
    // Snapshot / failure captures land under the output dir so the scoped Files
    // endpoints (and the run-history UI) can serve them.
    const outputDir = await ensureOutputDir();

    await host.start();
    await host.launch(headless);

    const outcome = await runAutomation(host, automation, {
      scraped: {},
      vars: opts.variables,
      dir: runDir,
      // Watch pacing: pause between steps (long after a click/nav, tiny after
      // typing) so a slowed run can be followed; off ⇒ full speed (no gate).
      beforeStep:
        speed === 'off'
          ? undefined
          : async ({ prevAction }) => {
              const ms = smartWaitMs(prevAction, speed);
              if (ms > 0) await sleep(ms);
              return 'go';
            },
      // Build a per-step timeline: capture a frame (HTML + screenshot) after each
      // screen-changing step (not typing/asserts), persisted via saveArtifact so
      // the run history / player can show what each step did. Cleanup: Phase 6.
      captureFrame: capturesFrame,
      emit: (r) => {
        if (r.status !== 'running') {
          steps.push(r);
          const label = `${r.action} [${r.index}]`;
          if (r.status === 'failed') diag?.warn(`step failed: ${label}`, { error: r.error, finalUrl: r.finalUrl });
          else diag?.step(`step ${r.status}: ${label}`);
        }
        emit({ type: 'automation:step', automation: automation.name, result: r });
      },
      screenshotPath: (index) => resolve(SHOTS_DIR, `${automation.id}-${startedAt}-${index.replace(/\W+/g, '_')}.png`),
      writeFile: (path, content) => writeAutomationFile(automation, runDir, startedAt, path, content),
      saveArtifact: (index, captures, label) =>
        saveRunArtifact(automation, startedAt, outputDir, index, captures, label),
    });

    const run = recordAutomationRun({
      automation: automation.name,
      automationId: automation.id,
      correlationId,
      status: outcome.status,
      steps: outcome.steps,
      scraped: outcome.scraped,
      startedAt,
      durationMs: Date.now() - startedAt,
    });
    diag.info('finished', { status: outcome.status, steps: outcome.steps.length });
    void diag.finish(outcome.status === 'failed' ? 'error' : 'ok');
    // Only hold the window open if it's actually still there — a run that failed
    // *because* the user closed the browser has nothing left to inspect.
    hold = !headless && host.alive && (keepOpen || outcome.status === 'failed');
    if (hold) holdBrowser(host, automation.name);
    emit({ type: 'automation:run:completed', run, heldOpen: hold });
    return run;
  } catch (err) {
    // A setup, host, or launch failure (rather than a step failure) still
    // completes as a recorded failed run so the UI isn't left hanging on
    // "Running…". The error itself used to be dropped here — capture it in the
    // diagnostic so launch failures on other machines (missing node/playwright/
    // Chrome) are debuggable. `diag` may be unset if startDiagnostics itself threw.
    diag?.fail(err, { phase: 'launch/host', automation: automation.name });
    void diag?.finish('error');
    const run = recordAutomationRun({
      automation: automation.name,
      automationId: automation.id,
      correlationId,
      status: 'failed',
      steps,
      scraped: {},
      startedAt,
      durationMs: Date.now() - startedAt,
    });
    emit({ type: 'automation:run:completed', run });
    return run;
  } finally {
    // Held browsers stay up; everything else is torn down.
    if (!hold) {
      await host.close().catch(() => {});
      host.kill();
    }
  }
}

// Never leak a held headed Chromium if the server is killed.
function killHeldOnExit(): void {
  heldHost?.kill();
}
process.on('exit', killHeldOnExit);
process.on('SIGINT', () => {
  killHeldOnExit();
  process.exit(0);
});
process.on('SIGTERM', () => {
  killHeldOnExit();
  process.exit(0);
});
