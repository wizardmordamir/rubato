import type { CaptureEntry } from './capture';

/**
 * Wire types for the Playwright automation builder, shared between the rubato
 * server, the Node browser host, and the web UI. Pure types only (no runtime
 * imports) so the UI can import them via the @shared Vite alias.
 *
 * An Automation is an ordered list of Steps. Each Step is an action applied to a
 * targeted element (a Target). The builder UI assembles them; the interpreter
 * (src/lib/interpreter.ts) runs them against a Playwright Page that lives in a
 * Node subprocess (Playwright can't be driven from Bun — see browser-host.mjs).
 */

/** How to locate an element on the page. Mirrors the e2e examples' vocabulary. */
export type TargetKind =
  | 'role' // getByRole(value, { name })  — preferred, accessible
  | 'testid' // getByTestId(value)         — data-testid
  | 'text' // getByText(value)
  | 'label' // getByLabel(value)
  | 'placeholder' // getByPlaceholder(value)
  | 'id' // #value
  | 'class' // .value
  | 'href' // a[href="value"]
  | 'css'; // raw CSS / Playwright selector

export interface Target {
  kind: TargetKind;
  /** The role name, testid, text, css selector, etc. */
  value: string;
  /** Accessible name (role kind) or exact-text qualifier. */
  name?: string;
  /** Match text/name exactly rather than as a substring. */
  exact?: boolean;
  /** Pick the nth match (0-based) when several match. */
  nth?: number;
  /** Scope the search within another target ("the Save button within the modal"). */
  container?: Target;
}

/** Leaf actions (everything except the `if` control step). */
export type LeafAction =
  | 'goto'
  | 'waitFor'
  | 'click'
  | 'hover'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'press'
  | 'setFiles' // upload file(s) into a file <input> (setInputFiles)
  | 'dialog' // arm a one-shot handler for the NEXT native dialog (accept/dismiss)
  | 'newTab' // open a new browser tab and make it the active page
  | 'switchTab' // make an existing tab (by index) the active page
  | 'closeTab' // close the active tab and fall back to the previous one
  | 'expectText'
  | 'expectUrl'
  | 'expectTitle'
  | 'expectVisible'
  | 'expectHidden'
  | 'expectEnabled'
  | 'expectDisabled'
  | 'expectValue' // an input's value equals (or, with a /regex/, matches)
  | 'expectAttribute' // an element's attribute equals (or, with a /regex/, matches)
  | 'expectCount'
  | 'scrape'
  | 'screenshot'
  | 'snapshot'
  | 'saveFile';

export type ActionType = LeafAction | 'if';

/** Per-action parameters. Which fields apply depends on the action. */
export interface StepParams {
  /** goto / newTab: url to navigate to (newTab opens it in the new tab). */
  url?: string;
  /**
   * fill / press / select / expectText / expectUrl / expectTitle / expectCount.
   * expectValue / expectAttribute: the expected value (exact, or a `/regex/`).
   * setFiles: one or more file paths to upload (newline- or comma-separated;
   * supports ${run.dir}/${VAR}).
   * dialog: the prompt text supplied when accepting a `prompt()` dialog.
   * saveFile: the content to write (supports ${scraped.NAME}/${VAR}); when blank
   * the whole scrape bag is written as JSON.
   * snapshot: an optional label for the capture (shown in the run history and
   * baked into the artifact filename).
   */
  value?: string;
  /**
   * How `value` is supplied (fill-like steps). Undefined = plain text (today's
   * behavior; still honors ${VAR}/${scraped.x}).
   *  - "secret": `value` is a literal secret. The builder masks it (a password
   *    input) so onlookers don't see it, and the runner redacts it from logs and
   *    error messages. The value is still stored in the automation JSON.
   *  - "env": `value` holds an environment-variable NAME (not the secret itself).
   *    The runner resolves it from the run environment (process.env / ~/.rubato/
   *    .env), redacted; exported specs read it as process.env[name]. Nothing
   *    sensitive is stored in the automation.
   */
  valueMode?: 'secret' | 'env';
  /** waitFor: how to wait. */
  waitKind?: 'ms' | 'networkidle' | 'load' | 'visible' | 'hidden';
  /** waitFor (ms). */
  ms?: number;
  /** expectCount: expected number of matches. switchTab: tab index (0-based). */
  count?: number;
  /** scrape: read "text" (default) or an attribute name. expectAttribute: the attribute name. */
  attr?: string;
  /**
   * scrape: optionally extract a substring from the captured text with a regex.
   * Accepts a bare pattern or a `/pattern/flags` literal (e.g. `/sha256:(\S+)/`).
   * The first capture group is stored if present, else the whole match; no match
   * stores an empty string. So "find the sha256: line, grab the digest" is one step.
   */
  regex?: string;
  /** dialog: whether to accept (default) or dismiss the next native dialog. */
  dialogAction?: 'accept' | 'dismiss';
  /** scrape: variable name to store the result under (referenced as ${scraped.NAME}). */
  saveAs?: string;
  /**
   * screenshot: output file path (optional; defaults to the run's dir).
   * saveFile: output path (supports ${...}); relative paths land under
   * ~/.rubato/automation-data/, blank uses a default per-run filename.
   */
  path?: string;
}

export interface StepOptions {
  /** Per-step timeout (ms). */
  timeout?: number;
  /** Don't fail the run if this step fails (record it skipped/failed, continue). */
  optional?: boolean;
}

/** A condition for an `if` step. Evaluated non-fatally (errors ⇒ false). */
export interface Condition {
  kind: 'url-matches' | 'selector-visible' | 'selector-hidden';
  /** For url-matches: a substring or /regex/ the current URL must match. */
  value?: string;
  /** For selector-visible/hidden. */
  target?: Target;
}

export interface Step {
  id: string;
  action: ActionType;
  target?: Target;
  params?: StepParams;
  options?: StepOptions;
  /** Free-text note shown in the builder. */
  note?: string;
  // `if` only (named *Steps to avoid the thenable-confusion lint rule):
  condition?: Condition;
  thenSteps?: Step[];
  elseSteps?: Step[];
}

export interface Automation {
  /** Stable id / filename slug. */
  id: string;
  name: string;
  description?: string;
  /** Where a run starts (an implicit first goto). */
  startUrl?: string;
  steps: Step[];
  /**
   * Optional capture track: when a flow was built with "Capture screens" on, the
   * build session also recorded each moment's HTML + a screenshot into a capture
   * session (artifacts live in `~/.rubato/captures/<id>` via captureStore). This
   * references that session so the saved flow keeps its inspectable/exportable
   * timeline alongside its editable steps. Absent for steps-only automations.
   */
  capture?: { id: string; count: number; startedAt: number; stoppedAt?: number };
  createdAt: number;
  updatedAt: number;
}

/**
 * Live status of the single headed build/capture session (for the builder UI to
 * hydrate its toolbar on mount/reload). `captureId`/`captureCount` describe the
 * capture track being recorded when "Capture screens" is on.
 */
export interface SessionStatus {
  active: boolean;
  url: string;
  recording: boolean;
  capturing: boolean;
  captureId?: string;
  captureCount: number;
}

/**
 * A variable an automation references, with whether it's already resolvable from
 * the environment. `present` reflects ~/.rubato/.env / process.env — the secret
 * value itself is never sent to the client.
 */
export interface AutomationVariable {
  name: string;
  present: boolean;
  sources: string[];
}

export type StepStatus = 'running' | 'passed' | 'failed' | 'skipped';

/** The result of executing one step (streamed live + persisted). */
export interface StepResult {
  stepId: string;
  /** Dotted index into the (possibly nested) step tree, e.g. "2" or "2.then.0". */
  index: string;
  action: ActionType;
  status: StepStatus;
  /** Resolved selector string, for display. */
  selector?: string;
  matchCount?: number;
  /** scrape: the captured value (variable name → value also lands in the bag). */
  scraped?: { name: string; value: string };
  error?: string;
  durationMs: number;
  /** Page URL after the step ran — shows where a goto/click actually landed. */
  finalUrl?: string;
  /** Browser console errors / page errors / failed requests during the step. */
  logs?: string[];
  /**
   * data: URL screenshot of the page state, captured when a step fails. A
   * transient fallback for contexts with no output dir to persist into (e.g. the
   * build session or tests); production runs persist to `screenshotPath` instead.
   */
  screenshot?: string;
  /**
   * Path (relative to the output dir) of a persisted full-page screenshot —
   * written by a `snapshot` step or captured at the moment a step failed. The UI
   * loads it via /api/files/raw. Persisted with the run, so previous runs keep it.
   */
  screenshotPath?: string;
  /**
   * Path (relative to the output dir) of the page's HTML at this moment — a
   * `snapshot` step, or the DOM at the moment a step failed. Opened/rendered
   * (sandboxed) from /api/files/raw so a tester can see *why* a step failed.
   */
  htmlPath?: string;
  /** Page network requests during this step (metadata only); shown in the player. */
  network?: NetworkEntry[];
}

/** Live state of the step-through (one-at-a-time) executor. */
export interface StepRunnerStatus {
  /** A headed step session is open. */
  active: boolean;
  /** idle = no run in progress; step = paused awaiting next; play = auto-advancing. */
  mode: 'idle' | 'step' | 'play';
  /** Dotted index of the step at the cursor (the one about to run / just paused at). */
  cursor: string | null;
  /** The automation being stepped. */
  automation: string | null;
}

/** Final record of an automation run (persisted to SQLite). */
export interface AutomationRunRecord {
  id: number;
  automation: string;
  /** The automation's id (slug), so a run's on-disk artifacts can be located for
   *  cleanup. Absent on runs recorded before this was tracked. */
  automationId?: string;
  /** Correlation id of the request that launched the run — fetches its server
   *  logs + captured outbound calls (GET /api/debug-capture/logs). */
  correlationId?: string;
  status: 'passed' | 'failed';
  steps: StepResult[];
  /** Collected scrape results (name → value). */
  scraped: Record<string, string>;
  startedAt: number;
  durationMs: number;
}

// ── Node browser-host stdio protocol ────────────────────────────────────────
// Bun writes one HostCommand JSON per stdin line; the host replies with one
// HostResponse per stdout line (matched by id) and may emit unsolicited
// HostEvents (no id) for picker/recorder/navigation.

export type HostCommand =
  | { id: number; cmd: 'launch'; headless: boolean; url?: string }
  | { id: number; cmd: 'goto'; url: string }
  | {
      id: number;
      cmd: 'action';
      action: LeafAction;
      target?: Target;
      params?: StepParams;
      timeout?: number;
      /** Also capture a frame (HTML + screenshot) of the page after the action. */
      capture?: boolean;
    }
  | { id: number; cmd: 'check-condition'; condition: Condition; timeout?: number }
  | { id: number; cmd: 'test-selector'; target: Target }
  | { id: number; cmd: 'highlight'; target: Target }
  | { id: number; cmd: 'arm-picker' }
  | { id: number; cmd: 'arm-recorder' }
  | { id: number; cmd: 'arm-capture' }
  // Toggle artifact capture on/off without stopping the recorder (unified session).
  | { id: number; cmd: 'set-capture'; on: boolean }
  | { id: number; cmd: 'capture-frame' }
  | { id: number; cmd: 'stop-mode' }
  | { id: number; cmd: 'url' }
  | { id: number; cmd: 'close' };

/**
 * One page network request observed during a step (metadata only — never bodies
 * or headers, to keep the run record small and avoid leaking secrets). Captured
 * by the browser host on meaningful steps and shown in the player's Network tab.
 */
export interface NetworkEntry {
  method: string;
  url: string;
  /** HTTP status, or 0 when the request failed before a response. */
  status: number;
  durationMs?: number;
  /** Set when the request errored (net::ERR…); `url` then carries no status. */
  failed?: boolean;
}

/** Outcome of a single host-executed action. */
export interface ActionOutcome {
  matchCount?: number;
  /** scrape: the read value. */
  value?: string;
  /** screenshot: where it was written, or a data: URL. */
  path?: string;
  error?: string;
  /** Page URL after the action (every action reports it). */
  finalUrl?: string;
  /** Console errors / page errors / failed requests seen during the action. */
  logs?: string[];
  /** data: URL screenshot of the page — a `snapshot` capture or a failure shot. */
  screenshot?: string;
  /** The page's full HTML — a `snapshot` capture, or the DOM at the moment of failure. */
  html?: string;
  /** Page network requests during the step (meaningful steps, when capturing). */
  network?: NetworkEntry[];
}

// A failed response can still carry diagnostics (final URL, logs, a screenshot)
// gathered at the moment of failure, so the UI can show *why* a step failed.
export type HostResponse =
  | { id: number; ok: true; result: ActionOutcome }
  | { id: number; ok: false; error: string; outcome?: ActionOutcome };

export type HostEvent =
  | { event: 'ready' }
  | { event: 'picked'; target: Target; selector: string }
  | { event: 'recorded-step'; step: Step }
  | { event: 'navigated'; url: string }
  // Capture mode: a recorded moment + its page HTML and screenshot (data: URL).
  | { event: 'capture-event'; entry: CaptureEntry; html?: string; screenshot?: string }
  | { event: 'closed' };
