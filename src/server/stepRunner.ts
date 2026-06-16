/**
 * Live step-through executor: run an automation one action at a time in a real
 * (headed) browser, pausing between steps so you can watch each one and inspect
 * the page. Built on the SAME interpreter as a normal run — it just supplies a
 * `beforeStep` gate (the Phase-0 seam) that blocks until "next"/"play", so there's
 * no second execution engine. One global session (a loopback personal tool, like
 * browserSession). Per-step results stream over the existing
 * automation:step events (so the builder lights up), plus automation:step:state
 * for the cursor/mode. A finished stepped run is recorded like any other run.
 */

import { currentCorrelationId } from '../lib/correlation';
import { type BrowserDriver, runAutomation } from '../lib/interpreter';
import type { Automation, StepResult, StepRunnerStatus } from '../shared/automation';
import { type RunSpeed, smartWaitMs } from '../shared/pacing';
import { BrowserHost } from './browserHost';
import { recordAutomationRun } from './db';
import { setCaptureEnabled } from './debugCapture';
import { emit } from './events';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Mode = StepRunnerStatus['mode'];

/**
 * The slice of BrowserHost the step runner drives. Named as a type so a test can
 * inject a fake host (via startStep's factory) and exercise the session lifecycle —
 * most importantly browser-closed detection — without spawning a real browser.
 */
export interface StepHost extends BrowserDriver {
  start(): Promise<void>;
  launch(headless: boolean, url?: string): Promise<unknown>;
  close(): Promise<void>;
  kill(): void;
  onExit: ((code: number | null) => void) | null;
}

let host: StepHost | null = null;
let current: Automation | null = null;
let mode: Mode = 'idle';
let cursor: string | null = null;
let speed: RunSpeed = 'slow';
let stopped = false;
let gateResolve: ((v: 'go' | 'abort') => void) | null = null;
let steps: StepResult[] = [];
let startedAt = 0;
let correlationId: string | undefined;
// Set when the user closes the headed window out from under an active run (see
// onHostGone), so finish() records a failure instead of a misleading pass.
let browserClosed = false;

function status(): StepRunnerStatus {
  return { active: host != null, mode, cursor, automation: current?.name ?? null };
}

function emitState(extra: { paused?: boolean; done?: boolean } = {}): void {
  emit({ type: 'automation:step:state', automation: current?.name ?? '', mode, cursor, ...extra });
}

/** Resolve the pending gate (if a step is blocked awaiting a command). */
function release(v: 'go' | 'abort'): void {
  const r = gateResolve;
  gateResolve = null;
  r?.(v);
}

/**
 * Fired once when the host process is gone for ANY reason (crash, our own kill, or
 * the user closing the headed window). We only care about the last case: a window
 * the user closed out from under us. Our own teardown (stopStep) nulls `host` and
 * sets `stopped` first, and a superseded session is no longer `host`, so those are
 * ignored here.
 *
 * Without this, closing the browser while a step run is PAUSED (step mode, blocked
 * in the gate awaiting Next/Play — not on a host command) was never noticed, so
 * `automation:run:completed` never fired and the UI hung on "Running…" forever.
 */
function onHostGone(h: StepHost): void {
  if (host !== h || stopped) return;
  if (mode === 'idle') {
    // A finished run was holding its headed window open for inspection and the user
    // closed it — drop the "kept open" banner, like a normal headed run does.
    host = null;
    emit({ type: 'automation:browser:closed', automation: current?.name ?? '' });
    return;
  }
  // Closed mid-run: unblock a paused step gate so the interpreter unwinds (an
  // in-flight command was already rejected by the host), and mark the run failed so
  // finish() doesn't record a misleading pass for a run that never completed.
  browserClosed = true;
  release('abort');
}

/** The Phase-0 beforeStep gate: pace in play mode; block in step mode. */
async function gate(info: {
  index: string;
  prevAction?: Automation['steps'][number]['action'];
}): Promise<'go' | 'abort'> {
  if (stopped) return 'abort';
  cursor = info.index;
  if (mode === 'play') {
    const ms = smartWaitMs(info.prevAction, speed);
    if (ms > 0) await sleep(ms);
    emitState();
    return stopped ? 'abort' : 'go';
  }
  // step mode: pause here until next/play/stop.
  emitState({ paused: true });
  return new Promise<'go' | 'abort'>((resolve) => {
    gateResolve = resolve;
  });
}

function finish(st: 'passed' | 'failed'): void {
  const wasStopped = stopped;
  // The user closed the headed window out from under the run (onHostGone): the
  // browser is gone (nothing to hold open) and the run never finished, so record it
  // as a failure rather than whatever partial verdict the interpreter unwound with.
  const closed = browserClosed;
  browserClosed = false;
  mode = 'idle';
  cursor = null;
  gateResolve = null;
  if (closed) host = null;
  // A user-aborted session is torn down by stopStep — don't record a partial run.
  if (wasStopped) return;
  const run = recordAutomationRun({
    automation: current?.name ?? 'step',
    automationId: current?.id,
    correlationId,
    status: closed ? 'failed' : st,
    steps,
    scraped: {},
    startedAt,
    durationMs: Date.now() - startedAt,
  });
  emit({ type: 'automation:run:completed', run, heldOpen: host != null });
  emitState({ done: true });
}

/** Open a headed browser and pause before the first step. The host factory is a
 *  seam for tests; production always spawns a real BrowserHost. */
export async function startStep(
  automation: Automation,
  sp: RunSpeed = 'slow',
  makeHost: () => StepHost = () => new BrowserHost(),
): Promise<StepRunnerStatus> {
  await stopStep();
  stopped = false;
  browserClosed = false;
  mode = 'step';
  cursor = null;
  speed = sp;
  current = automation;
  steps = [];
  startedAt = Date.now();
  correlationId = currentCorrelationId();
  setCaptureEnabled(true);
  host = makeHost();
  await host.start();
  await host.launch(false); // headed — you watch it
  // Arm browser-closed detection now the window is actually up: if the user shuts
  // it mid-run, onHostGone unblocks the run so it completes instead of hanging.
  const liveHost = host;
  liveHost.onExit = () => onHostGone(liveHost);
  emit({ type: 'automation:run:started', automation: automation.name });
  void runAutomation(host, automation, {
    scraped: {},
    emit: (r) => {
      if (r.status !== 'running') steps.push(r);
      emit({ type: 'automation:step', automation: automation.name, result: r });
    },
    beforeStep: gate,
  })
    .then((o) => finish(o.status))
    .catch(() => finish('failed'));
  return status();
}

/** Run the step at the cursor and pause at the next one. */
export function stepNext(): StepRunnerStatus {
  if (host && mode === 'step') release('go');
  return status();
}

/** Auto-advance (paced) from here on. */
export function stepPlay(): StepRunnerStatus {
  if (host && mode !== 'idle') {
    mode = 'play';
    release('go');
    emitState();
  }
  return status();
}

/** Stop auto-advancing; pause at the next step boundary. */
export function stepPause(): StepRunnerStatus {
  if (host && mode === 'play') {
    mode = 'step';
    emitState();
  }
  return status();
}

/** Re-run the current automation from the start (a real browser can't reverse). */
export async function stepRestart(): Promise<StepRunnerStatus> {
  const a = current;
  const sp = speed;
  if (!a) return status();
  return startStep(a, sp);
}

/** Abort and close the headed browser. */
export async function stopStep(): Promise<StepRunnerStatus> {
  if (!host) return status();
  stopped = true;
  mode = 'idle';
  release('abort');
  const h = host;
  host = null;
  await h.close().catch(() => {});
  h.kill();
  cursor = null;
  emitState({ done: true });
  return status();
}

export function stepStatus(): StepRunnerStatus {
  return status();
}

// Never leak the headed browser if the server is killed.
process.on('exit', () => host?.kill());
process.on('SIGINT', () => {
  host?.kill();
  process.exit(0);
});
process.on('SIGTERM', () => {
  host?.kill();
  process.exit(0);
});
