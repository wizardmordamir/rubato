/**
 * Node-only Playwright executor for the rubato automation builder.
 *
 * Playwright does NOT work under Bun's native runtime — chromium.launch() hangs,
 * and launchServer+connect-from-Bun also hangs (Bun's WebSocket client never
 * completes Playwright's handshake; verified 2026-06). So ALL Playwright calls
 * live here in Node. The Bun server (src/server/browserHost.ts) spawns this with
 * `node` and drives it over a JSON-line stdio protocol:
 *
 *   Bun → stdin : one HostCommand JSON per line   ({id, cmd, ...})
 *   Node → stdout: one HostResponse per line       ({id, ok, result|error})
 *                  plus unsolicited HostEvents      ({event, ...}) for the
 *                  picker / recorder / navigation.
 *
 * Protocol shapes are defined in src/shared/automation.ts. This file is plain
 * .mjs (no TypeScript) so `node` can run it with no loader/build step.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_TIMEOUT = 15_000;

/**
 * Does Playwright's bundled Chromium *look* installed? Only a hint for ordering
 * launch attempts — it checks for a `chromium*` cache dir but can't tell a stale
 * or partial install (e.g. a leftover build from before a Playwright bump) from a
 * working one, so the launch itself must still fall back rather than trust this.
 */
/** Playwright's default browser-cache dir, per platform (overridable via env). */
function playwrightCacheDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return resolve(homedir(), "Library/Caches/ms-playwright");
  if (process.platform === "win32") return resolve(process.env.LOCALAPPDATA || homedir(), "ms-playwright");
  return resolve(homedir(), ".cache/ms-playwright"); // Linux / other
}

function hasBundledChromium() {
  const cacheDir = playwrightCacheDir();
  return existsSync(cacheDir) && readdirSync(cacheDir).some((d) => d.startsWith("chromium"));
}

/**
 * Launch a browser, preferring the system's installed Google Chrome
 * (`channel: "chrome"`). Many environments forbid downloading Playwright's
 * Chromium but already have Chrome, so Chrome goes first; bundled Chromium is
 * only attempted as a fallback when it actually looks installed (no point
 * launching a binary that isn't there). Only errors if neither can launch.
 */
async function launchBrowser(headless) {
  const base = { headless, args: ["--no-first-run", "--no-default-browser-check"] };
  const bundled = { label: "bundled Chromium", options: base };
  const chrome = { label: "system Chrome", options: { ...base, channel: "chrome" } };
  const candidates = hasBundledChromium() ? [chrome, bundled] : [chrome];

  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const { label, options } = candidates[i];
    try {
      const b = await chromium.launch(options);
      if (i > 0) pushLog(`launched ${label} (fell back from ${candidates[0].label})`);
      return b;
    } catch (err) {
      lastErr = err;
      pushLog(`launch ${label} failed: ${String(err.message).split("\n")[0]}`);
    }
  }
  throw new Error(
    `no browser could be launched (tried ${candidates.map((c) => c.label).join(", ")}). ` +
      `Install one with \`bunx playwright install chromium\` or Google Chrome. Last error: ${lastErr?.message}`,
  );
}

let browser = null;
let context = null;
let page = null;
/** "idle" | "picking" | "recording" — set via arm-picker/arm-recorder/stop-mode. */
let mode = "idle";
/**
 * Data-gathering ("capture") mode: while on, every recorded interaction and every
 * navigation also emits a `capture-event` carrying the page HTML + a screenshot, so
 * the Bun side can persist an exportable bundle of the screens/actions. Reuses the
 * recorder (mode === "recording"); this just adds the per-event HTML/shot capture.
 */
let capturing = false;
let captureSeq = 0;
/**
 * True while WE are closing the browser (relaunch, the `close` command, or
 * shutdown). A `disconnected` event seen while this is false means the user (or a
 * crash) closed the window — we exit with EXIT_BROWSER_CLOSED so the Bun side can
 * report a clean failure instead of waiting on a browser that's gone.
 */
let intentionalClose = false;
const EXIT_BROWSER_CLOSED = 75;

/**
 * Rolling buffer of noteworthy browser output (console errors/warnings, uncaught
 * page errors, failed network requests). Listeners are (re)attached on each
 * launch. A step grabs the slice produced while it ran (see `diag`), so the UI
 * can show e.g. `net::ERR_NAME_NOT_RESOLVED` that explains a failed goto.
 */
let consoleBuf = [];
function pushLog(line) {
  consoleBuf.push(line);
  if (consoleBuf.length > 500) consoleBuf.shift();
}

/**
 * Rolling buffer of page network requests (metadata only — method/url/status/
 * timing, NEVER bodies or headers). A capturing step drains the entries seen
 * since the previous drain (`drainNetwork`) and returns them on its outcome, so
 * the player's Network tab shows what each step's screen fetched. Bounded so a
 * chatty page between two captures can't grow it without limit.
 */
let networkBuf = [];
const MAX_URL = 300;
function pushNetwork(entry) {
  networkBuf.push(entry);
  if (networkBuf.length > 300) networkBuf.shift();
}
function drainNetwork() {
  if (networkBuf.length === 0) return undefined;
  const out = networkBuf;
  networkBuf = [];
  return out;
}

// ── stdout helpers ──────────────────────────────────────────────────────────
function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
const reply = (id, result) => send({ id, ok: true, result: result ?? {} });
const fail = (id, error, outcome) => send({ id, ok: false, error: String(error?.message ?? error), outcome });
const emit = (event) => send(event);

/**
 * Diagnostics captured at the boundary of a step: where the page ended up and
 * any browser logs since `mark` (the buffer length recorded before the step).
 * Kept small (last 50 lines) so it streams/persists cheaply.
 */
function diag(mark) {
  const out = {};
  try {
    if (page) out.finalUrl = page.url();
  } catch {
    // page may be navigating/closed
  }
  const logs = consoleBuf.slice(mark, mark + 200).slice(-50);
  if (logs.length) out.logs = logs;
  return out;
}

/** A viewport JPEG of the current page as a data: URL, for failure inspection. */
async function failureShot() {
  if (!page) return undefined;
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 45, timeout: 5000 });
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** The page's current HTML, for failure inspection / snapshots. Never throws. */
async function pageHtml() {
  if (!page) return undefined;
  try {
    return await page.content();
  } catch {
    return undefined;
  }
}

/**
 * Grab a capture frame (HTML + a full-page JPEG) of the current page. JPEG keeps a
 * many-screen session's bundle small; HTML is the data we mine selectors from.
 * Never throws — capture is best-effort and must not interrupt the user.
 */
async function captureFrame() {
  if (!page) return null;
  let html;
  let screenshot;
  try {
    html = await page.content();
  } catch {
    html = undefined;
  }
  try {
    const buf = await page.screenshot({ fullPage: true, type: "jpeg", quality: 60, timeout: 8000 });
    screenshot = `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    screenshot = undefined;
  }
  let url = "";
  try {
    url = page.url();
  } catch {
    // navigating/closed
  }
  return { url, html, screenshot };
}

/** Emit a capture-event for the Bun side to persist (best-effort; swallows errors). */
async function emitCapture(entry) {
  if (!capturing) return;
  try {
    const frame = await captureFrame();
    if (!frame) return;
    emit({
      event: "capture-event",
      entry: { seq: captureSeq++, ts: Date.now(), url: frame.url, ...entry },
      html: frame.html,
      screenshot: frame.screenshot,
    });
  } catch {
    // never let capture break the session
  }
}

/**
 * Capture an in-progress text edit that hasn't been recorded yet. The injected
 * recorder only emits a `fill` when the edit *ends* (blur/commit/click). But a
 * field can still be focused when the user stops capturing (the Stop button is in
 * another window, so the field never blurs) or when a script navigates the page —
 * so we drain the recorder's pending edit synchronously (`__rubatoTakePending`,
 * no binding round-trip) and capture a final `action` frame for it. Best-effort.
 */
async function flushPendingCapture() {
  if (!capturing || !page) return;
  let step;
  try {
    step = await page.evaluate(() => window.__rubatoTakePending && window.__rubatoTakePending());
  } catch {
    return; // page navigating/closed — nothing to drain
  }
  if (!step) return;
  await settleAfterAction();
  await emitCapture({ kind: "action", action: step.action, target: step.target, params: step.params });
}

/**
 * Give a click's effects a moment to render before we snapshot it: opening a
 * modal, swapping a panel, or kicking off a fetch all change which selectors are
 * on screen, and capturing too early would miss them. Best-effort and bounded —
 * a fixed beat for animations, then a short wait for the network to go quiet.
 */
async function settleAfterAction() {
  if (!page) return;
  await page.waitForTimeout(300).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
}

// ── locator resolution (mirrors targetToSelectorString in src/lib/locator.ts) ─
function resolveLocator(root, target) {
  const base = target.container ? resolveLocator(root, target.container) : root;
  let loc;
  switch (target.kind) {
    case "role":
      loc = base.getByRole(target.value, target.name ? { name: target.name, exact: !!target.exact } : undefined);
      break;
    case "testid":
      loc = base.getByTestId(target.value);
      break;
    case "text":
      loc = base.getByText(target.value, { exact: !!target.exact });
      break;
    case "label":
      loc = base.getByLabel(target.value, { exact: !!target.exact });
      break;
    case "placeholder":
      loc = base.getByPlaceholder(target.value, { exact: !!target.exact });
      break;
    case "id":
      loc = base.locator(`#${cssEscape(target.value)}`);
      break;
    case "class":
      loc = base.locator(`.${cssEscape(target.value)}`);
      break;
    case "href":
      loc = base.locator(`a[href="${target.value.replace(/"/g, '\\"')}"]`);
      break;
    case "css":
      loc = base.locator(target.value);
      break;
    default:
      throw new Error(`unknown target kind: ${target.kind}`);
  }
  if (typeof target.nth === "number") loc = loc.nth(target.nth);
  return loc;
}

function cssEscape(s) {
  // Minimal escape for ids/classes that contain CSS-special chars.
  return s.replace(/([ !"#$%&'()*+,./:;<=>?@[\]^`{|}~])/g, "\\$1");
}

async function poll(fn, timeout) {
  const start = Date.now();
  let lastErr = new Error("timed out");
  for (;;) {
    try {
      const r = await fn();
      if (r !== false) return r;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - start > timeout) throw lastErr;
    await sleep(150);
  }
}

// ── action execution ────────────────────────────────────────────────────────
// Actions that act on a specific element — kept in lockstep with
// `actionNeedsTarget` in src/lib/interpreter.ts. Mirrored here (the interpreter
// guards first) so a step driven straight at the host can't null-deref `loc`.
const NEEDS_TARGET = new Set([
  "click", "hover", "fill", "select", "check", "uncheck", "setFiles", "scrape",
  "expectText", "expectVisible", "expectHidden", "expectEnabled", "expectDisabled",
  "expectValue", "expectAttribute", "expectCount",
]);

async function execAction(action, target, params, timeout) {
  const p = params ?? {};
  const t = timeout ?? p.timeout ?? DEFAULT_TIMEOUT;
  const loc = target ? resolveLocator(page, target) : null;

  // No element to act on → a clear error instead of "Cannot read properties of null".
  if (!loc && (NEEDS_TARGET.has(action) || (action === "waitFor" && (p.waitKind === "visible" || p.waitKind === "hidden")))) {
    throw new Error(`the "${action}" step has no target element to act on — pick the element for this step`);
  }

  switch (action) {
    case "goto":
      await page.goto(p.url ?? p.value, { timeout: t, waitUntil: "domcontentloaded" });
      return { matchCount: undefined };
    case "waitFor":
      return waitFor(loc, p, t);
    case "click":
      await loc.first().click({ timeout: t });
      return { matchCount: await loc.count() };
    case "hover":
      await loc.first().hover({ timeout: t });
      return { matchCount: await loc.count() };
    case "fill":
      await loc.first().fill(p.value ?? "", { timeout: t });
      return { matchCount: await loc.count() };
    case "select":
      await loc.first().selectOption(p.value ?? "", { timeout: t });
      return { matchCount: await loc.count() };
    case "check":
      await loc.first().check({ timeout: t });
      return {};
    case "uncheck":
      await loc.first().uncheck({ timeout: t });
      return {};
    case "press":
      if (loc) await loc.first().press(p.value ?? "Enter", { timeout: t });
      else await page.keyboard.press(p.value ?? "Enter");
      return {};
    case "setFiles": {
      const files = (p.value ?? "")
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      await loc.first().setInputFiles(files, { timeout: t });
      return { matchCount: await loc.count() };
    }
    case "dialog": {
      // Arm a one-shot handler for the NEXT native dialog (alert/confirm/prompt).
      // Must run BEFORE the step that triggers it. Playwright auto-dismisses
      // unhandled dialogs, so this lets a flow accept a confirm() and continue.
      const accept = p.dialogAction !== "dismiss";
      page.once("dialog", async (d) => {
        try {
          if (accept) await d.accept(p.value || undefined);
          else await d.dismiss();
        } catch {
          // dialog already handled / page navigated away
        }
      });
      return {};
    }
    case "newTab":
      return newTab(p);
    case "switchTab":
      return switchTab(p);
    case "closeTab":
      return closeTab();
    case "expectText":
      return expectText(loc, target, p, t);
    case "expectUrl":
      await poll(() => urlMatches(page.url(), p.value ?? ""), t);
      return {};
    case "expectTitle":
      await poll(async () => {
        const title = await page.title();
        return target?.exact ? title === (p.value ?? "") : title.includes(p.value ?? "");
      }, t);
      return {};
    case "expectVisible":
      await loc.first().waitFor({ state: "visible", timeout: t });
      return { matchCount: await loc.count() };
    case "expectHidden":
      // Resolves if the element is hidden OR detached (matches toBeHidden).
      await loc.first().waitFor({ state: "hidden", timeout: t });
      return {};
    case "expectEnabled":
      await poll(async () => (await loc.count()) > 0 && (await loc.first().isEnabled()), t);
      return { matchCount: await loc.count() };
    case "expectDisabled":
      await poll(async () => (await loc.count()) > 0 && (await loc.first().isDisabled()), t);
      return { matchCount: await loc.count() };
    case "expectValue":
      await poll(async () => {
        if ((await loc.count()) === 0) return false;
        return matchExpected(await loc.first().inputValue(), p.value ?? "");
      }, t);
      return { matchCount: await loc.count() };
    case "expectAttribute":
      await poll(async () => {
        if ((await loc.count()) === 0) return false;
        const actual = await loc.first().getAttribute(p.attr ?? "");
        return actual !== null && matchExpected(actual, p.value ?? "");
      }, t);
      return { matchCount: await loc.count() };
    case "expectCount": {
      const want = p.count ?? 0;
      await poll(async () => (await loc.count()) === want, t);
      return { matchCount: await loc.count() };
    }
    case "scrape":
      return scrape(loc, p, t);
    case "screenshot":
      return screenshot(p);
    case "snapshot":
      return snapshot();
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

async function waitFor(loc, p, t) {
  switch (p.waitKind) {
    case "ms":
      await sleep(p.ms ?? 1000);
      return {};
    case "networkidle":
      await page.waitForLoadState("networkidle", { timeout: t });
      return {};
    case "load":
      await page.waitForLoadState("load", { timeout: t });
      return {};
    case "visible":
      await loc.first().waitFor({ state: "visible", timeout: t });
      return { matchCount: await loc.count() };
    case "hidden":
      await loc.first().waitFor({ state: "hidden", timeout: t });
      return {};
    default:
      await sleep(p.ms ?? 500);
      return {};
  }
}

async function expectText(loc, target, p, t) {
  const expected = p.value ?? "";
  await poll(async () => {
    if ((await loc.count()) === 0) return false;
    const text = (await loc.first().innerText()) ?? "";
    return target?.exact ? text.trim() === expected : text.includes(expected);
  }, t);
  return { matchCount: await loc.count() };
}

async function scrape(loc, p, t) {
  await loc.first().waitFor({ state: "attached", timeout: t });
  const value = p.attr ? ((await loc.first().getAttribute(p.attr)) ?? "") : ((await loc.first().innerText()) ?? "");
  return { value };
}

async function screenshot(p) {
  if (p.path) {
    await page.screenshot({ path: p.path, fullPage: true });
    return { path: p.path };
  }
  const buf = await page.screenshot({ fullPage: false });
  return { path: `data:image/png;base64,${buf.toString("base64")}` };
}

/**
 * Capture both the page HTML and a full-page screenshot at this point in the run.
 * Returns them as content (HTML string + PNG data: URL); the Bun side persists
 * them to files under the output dir (it owns the paths), so previous runs can
 * show what the page looked like at each `snapshot` step.
 */
async function snapshot() {
  const html = await page.content();
  const buf = await page.screenshot({ fullPage: true });
  return { html, screenshot: `data:image/png;base64,${buf.toString("base64")}` };
}

function urlMatches(url, pattern) {
  const m = pattern.match(/^\/(.*)\/([a-z]*)$/);
  if (m) return new RegExp(m[1], m[2]).test(url);
  return url.includes(pattern);
}

/**
 * Compare an actual string against an expected one: a `/regex/flags` pattern
 * tests as a RegExp, anything else is exact equality (matching toHaveValue /
 * toHaveAttribute semantics). Used by expectValue / expectAttribute.
 */
function matchExpected(actual, expected) {
  const m = expected.match(/^\/(.*)\/([a-z]*)$/);
  if (m) return new RegExp(m[1], m[2]).test(actual);
  return actual === expected;
}

async function checkCondition(condition, t) {
  try {
    switch (condition.kind) {
      case "url-matches":
        return urlMatches(page.url(), condition.value ?? "");
      case "selector-visible":
        return await resolveLocator(page, condition.target).first().isVisible();
      case "selector-hidden":
        return !(await resolveLocator(page, condition.target).first().isVisible());
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// ── browser lifecycle ───────────────────────────────────────────────────────
async function launch(headless, url) {
  if (browser) await closeBrowser();
  // Fresh browser: from here on, a window the user closes should end the host.
  intentionalClose = false;
  browser = await launchBrowser(headless);
  browser.on("disconnected", () => {
    if (!intentionalClose) process.exit(EXIT_BROWSER_CLOSED);
  });
  context = await browser.newContext();
  await context.addInitScript(PICKER_SCRIPT);
  // Context-level binding so the picker works on every tab the run opens, not
  // just the first page.
  await context.exposeBinding("__rubatoEmit", (_source, payload) => onPickerPayload(payload));
  // Capture noteworthy browser output so a failing step can explain itself.
  consoleBuf = [];
  page = await context.newPage();
  wirePage(page);
  if (url) await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
}

/**
 * Attach the per-page listeners (navigation events + the console/error/request
 * log feed) to a page. Called for the first page and for every tab a `newTab`
 * step opens, so logs and navigation surface for whichever tab is active.
 */
function wirePage(p) {
  p.on("framenavigated", (frame) => {
    if (frame === p.mainFrame() && p === page) {
      emit({ event: "navigated", url: frame.url() });
      // Re-apply the picker/recorder mode onto the new document. Its freshly
      // injected script defaults __rubatoMode to "idle" (`|| "idle"`), so without
      // this the recorder would silently stop after the very first navigation —
      // every interaction on page 2+ of a walk-through would go unrecorded. The
      // init script's `|| "idle"` preserves a value we set, so this is order-safe.
      if (mode !== "idle") void p.evaluate((m) => ((window.__rubatoMode = m), undefined), mode).catch(() => {});
      // Capture each landed screen too (best-effort, after the DOM is parsed).
      if (capturing) {
        void p
          .waitForLoadState("domcontentloaded", { timeout: 8000 })
          .catch(() => {})
          .then(async () => {
            if (p !== page) return;
            // A same-document (SPA) nav can fire while a field is still focused —
            // record its typed value before the new screen. (Hard navs lose the old
            // document's pending edit, but those are flushed by the committing
            // key / submit click that triggered them.)
            await flushPendingCapture();
            return emitCapture({ kind: "navigate" });
          });
      }
    }
  });
  p.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning") pushLog(`console.${t}: ${m.text()}`);
  });
  p.on("pageerror", (err) => pushLog(`pageerror: ${err.message}`));
  p.on("requestfailed", (req) => {
    pushLog(`requestfailed: ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "failed"}`);
    if (p === page) pushNetwork({ method: req.method(), url: capUrl(req.url()), status: 0, failed: true });
  });
  // Page network for the per-step timeline (metadata only). Only the active page's
  // requests are recorded; a request's timing comes from its Playwright timing().
  p.on("requestfinished", async (req) => {
    if (p !== page) return;
    try {
      const res = await req.response();
      const timing = req.timing();
      const durationMs =
        timing && timing.responseEnd > 0 ? Math.max(0, Math.round(timing.responseEnd - timing.startTime)) : undefined;
      pushNetwork({ method: req.method(), url: capUrl(req.url()), status: res ? res.status() : 0, durationMs });
    } catch {
      // request/response went away (navigation) — skip it
    }
  });
}

/** Trim a URL for storage so a giant data:/query URL can't bloat the run record. */
function capUrl(url) {
  return url.length > MAX_URL ? `${url.slice(0, MAX_URL)}…` : url;
}

// ── multi-tab ───────────────────────────────────────────────────────────────
// The host tracks one "active" page; steps act on it. newTab opens another tab
// (in the same context, so cookies/auth are shared) and switches to it;
// switchTab/closeTab move between the context's open tabs.

async function newTab(p) {
  const np = await context.newPage();
  wirePage(np);
  page = np;
  if (p.url) await page.goto(p.url, { waitUntil: "domcontentloaded" }).catch(() => {});
  return {};
}

async function switchTab(p) {
  const pages = context.pages();
  const idx = p.count ?? 0;
  if (idx < 0 || idx >= pages.length) throw new Error(`no tab at index ${idx} (open tabs: ${pages.length})`);
  page = pages[idx];
  await page.bringToFront().catch(() => {});
  return {};
}

async function closeTab() {
  const closing = page;
  await closing.close().catch(() => {});
  const remaining = context.pages();
  if (remaining.length > 0) {
    page = remaining[remaining.length - 1];
  } else {
    page = await context.newPage();
    wirePage(page);
  }
  await page.bringToFront().catch(() => {});
  return {};
}

/** Close the browser on our terms, so its `disconnected` event isn't read as a user close. */
async function closeBrowser() {
  intentionalClose = true;
  await browser?.close().catch(() => {});
  browser = null;
}

// Picker/recorder payloads arrive from the injected script (Phase 3/4).
async function onPickerPayload(payload) {
  if (!payload) return;
  if (payload.kind === "picked") {
    emit({ event: "picked", target: payload.target, selector: payload.selector });
  } else if (payload.kind === "recorded-step") {
    emit({ event: "recorded-step", step: payload.step });
    // In capture mode, also bundle the page HTML + a screenshot alongside the action.
    if (capturing) {
      const s = payload.step ?? {};
      // Let the click's effects (modals, swapped panels, async content) render so
      // the snapshot reflects the screen the user actually ended up looking at.
      await settleAfterAction();
      await emitCapture({
        kind: "action",
        action: s.action,
        target: s.target,
        params: s.params,
      });
    }
  }
}

async function setMode(next) {
  mode = next;
  if (page) await page.evaluate((m) => ((window.__rubatoMode = m), undefined), next).catch(() => {});
}

// Injected into every page (survives navigations). Listens in the capture phase
// and, per window.__rubatoMode, emits a "picked" target (one-shot) or — in
// Phase 4 — records interactions. suggestTarget() is the selector heuristic.
const PICKER_SCRIPT = `(${function injected() {
  if (window.__rubatoInstalled) return;
  window.__rubatoInstalled = true;
  window.__rubatoMode = window.__rubatoMode || "idle";

  const FRAMEWORK_ID = /^(:r|radix-|headlessui-|react-aria|mui-|aria-)/i;
  const staticId = (id) =>
    !!id && !id.includes(":") && !FRAMEWORK_ID.test(id) && !/^[0-9a-f]{8,}$/i.test(id) && !/\d{4,}/.test(id);
  const uniqueCss = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const cssAttr = (s) => s.replace(/"/g, '\\"');
  const cssIdent = (s) => s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");

  const IMPLICIT = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", NAV: "navigation", IMG: "img" };
  const HEADINGS = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };
  function implicitRole(el) {
    const tag = el.tagName;
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (tag === "A") return el.hasAttribute("href") ? "link" : null;
    if (HEADINGS[tag]) return "heading";
    return IMPLICIT[tag] || null;
  }
  function accName(el) {
    const raw =
      el.getAttribute("aria-label") ||
      el.getAttribute("alt") ||
      (el.tagName === "INPUT" ? el.getAttribute("placeholder") : "") ||
      (el.textContent || "");
    return raw.trim().replace(/\\s+/g, " ").slice(0, 60);
  }
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel);
      if (uniqueCss(parts.join(" > "))) break;
      node = parent;
    }
    return parts.join(" > ");
  }
  // The selector heuristic ladder — first verifiable-unique / high-quality match.
  function suggestTarget(el) {
    const testid = el.getAttribute("data-testid");
    if (testid && uniqueCss('[data-testid="' + cssAttr(testid) + '"]')) return { kind: "testid", value: testid };
    if (staticId(el.id) && uniqueCss("#" + cssIdent(el.id))) return { kind: "id", value: el.id };
    const role = el.getAttribute("role") || implicitRole(el);
    const name = accName(el);
    if (role && name) return { kind: "role", value: role, name };
    const cls = Array.prototype.find.call(el.classList, (c) => uniqueCss("." + cssIdent(c)));
    if (cls) return { kind: "class", value: cls };
    if (el.tagName === "INPUT" && el.getAttribute("placeholder"))
      return { kind: "placeholder", value: el.getAttribute("placeholder") };
    if (el.tagName === "A" && el.getAttribute("href")) return { kind: "href", value: el.getAttribute("href") };
    if (role) return { kind: "role", value: role };
    return { kind: "css", value: cssPath(el) };
  }
  function display(t) {
    if (t.kind === "testid") return "testid=" + t.value;
    if (t.kind === "id") return "#" + t.value;
    if (t.kind === "class") return "." + t.value;
    if (t.kind === "role") return "role=" + t.value + (t.name ? "[name=" + JSON.stringify(t.name) + "]" : "");
    if (t.kind === "placeholder") return "placeholder=" + JSON.stringify(t.value);
    if (t.kind === "href") return 'a[href=' + JSON.stringify(t.value) + "]";
    return t.value;
  }
  window.__rubatoSuggest = (el) => {
    const target = suggestTarget(el);
    return { target, selector: display(target) };
  };

  const makeStep = (action, el, params) => {
    const step = { id: "rec-" + Math.random().toString(36).slice(2, 9), action, target: suggestTarget(el) };
    if (params) step.params = params;
    return step;
  };
  const record = (step) => window.__rubatoEmit({ kind: "recorded-step", step });

  // ── editable-field tracking ────────────────────────────────────────────────
  // What counts as a free-text field we capture by *value* (vs. a click/check).
  // Covers <input> (minus the non-text types), <textarea>, and any contenteditable
  // host (rich-text editors, which never fire `change`).
  const NON_TEXT_INPUT = {
    checkbox: 1, radio: 1, file: 1, submit: 1, button: 1, reset: 1, image: 1, range: 1, color: 1,
  };
  const inputType = (el) => (el.getAttribute("type") || "text").toLowerCase();
  const isTextLikeInput = (el) => el.tagName === "INPUT" && !NON_TEXT_INPUT[inputType(el)];
  const isTextEditable = (el) => !!el && (el.isContentEditable || el.tagName === "TEXTAREA" || isTextLikeInput(el));
  const editableValue = (el) => (el.isContentEditable ? el.innerText.replace(/\n+$/, "") : el.value);

  // lastFill remembers each field's last recorded value so any flush path (input
  // blur, a committing key, a following click, navigation, stop) is idempotent —
  // whichever fires first records the value, the rest are no-ops. This replaces
  // the old "mute the next change event" dance.
  const lastFill = new WeakMap();
  // The field currently being typed into but not yet recorded. We capture typing
  // by VALUE (one `fill` per edit), not keystroke-by-keystroke, so a screen+shot
  // isn't taken on every character. The edit is flushed when it ends (see below).
  let pendingEdit = null;
  // Build the `fill` step for a field's current value, or null if unchanged since
  // last record. A password field's value is captured too (so a recording is
  // faithful and replayable), but flagged `valueMode: "secret"` so the builder
  // masks it behind an eye toggle and the runner redacts it from logs.
  const fillStepFor = (el) => {
    if (!el || !el.isConnected) return null;
    const value = editableValue(el);
    if (lastFill.get(el) === value) return null;
    lastFill.set(el, value);
    const isPassword = el.tagName === "INPUT" && inputType(el) === "password";
    return makeStep("fill", el, isPassword ? { value, valueMode: "secret" } : { value });
  };
  const recordFill = (el) => {
    const step = fillStepFor(el);
    if (step) record(step);
    if (pendingEdit && pendingEdit.el === el) pendingEdit = null;
  };
  // Flush the in-progress edit (records one `fill` for the final value typed).
  const flushPending = () => {
    if (!pendingEdit) return;
    const el = pendingEdit.el;
    pendingEdit = null;
    const step = fillStepFor(el);
    if (step) record(step);
  };
  // Drain the pending edit and RETURN its step (for the host to capture a final
  // frame at stop-time, when the rubato Stop button lives in another window so the
  // field never blurs). Mirrors flushPending but doesn't emit through the binding.
  window.__rubatoTakePending = () => {
    if (!pendingEdit) return null;
    const el = pendingEdit.el;
    pendingEdit = null;
    return fillStepFor(el);
  };
  window.__rubatoFlush = flushPending;

  // Click: one-shot pick when picking; a click step when recording. Typed-text
  // fields and native toggles are left to the input/change handlers; everything
  // else (buttons, links, custom widgets, button-type inputs) records a click.
  document.addEventListener(
    "click",
    (e) => {
      const mode = window.__rubatoMode;
      if (mode === "picking") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const { target, selector } = window.__rubatoSuggest(e.target);
        window.__rubatoMode = "idle"; // one-shot pick
        window.__rubatoEmit({ kind: "picked", target, selector });
        return;
      }
      if (mode !== "recording") return;
      const el = e.target;
      // A click on a non-focusable element doesn't blur the edited field (no
      // focusout), so flush here too — the fill must be recorded before this click.
      flushPending();
      const tag = el.tagName;
      if (tag === "SELECT" || tag === "OPTION" || tag === "TEXTAREA") return;
      // Text inputs (fill), checkbox/radio (check/uncheck) and file inputs are
      // handled elsewhere; button-type inputs fall through to a click.
      if (tag === "INPUT" && (isTextLikeInput(el) || inputType(el) === "checkbox" || inputType(el) === "radio" || inputType(el) === "file"))
        return;
      const clickable =
        el.closest(
          "button, a, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=checkbox], [role=radio], [role=switch]",
        ) || el;
      record(makeStep("click", clickable));
    },
    true,
  );

  // Input: typing in a text field / textarea / contenteditable. We don't record
  // per keystroke — just remember the field as the pending edit; it's flushed to a
  // single `fill` when the edit ends (blur, a committing key, a click, navigation,
  // or stop). This is what captures text in fields the user never blurs and in
  // contenteditable editors that never fire `change`.
  document.addEventListener(
    "input",
    (e) => {
      if (window.__rubatoMode !== "recording") return;
      const el = e.target;
      if (isTextEditable(el)) pendingEdit = { el };
    },
    true,
  );

  // Focusout: the field lost focus — flush its typed value as a `fill`.
  document.addEventListener(
    "focusout",
    (e) => {
      if (window.__rubatoMode !== "recording") return;
      if (pendingEdit && pendingEdit.el === e.target) flushPending();
    },
    true,
  );

  // Change: final value of selects/checkboxes/inputs (fires on commit/blur for
  // native controls). recordFill is idempotent, so it harmlessly overlaps the
  // input/focusout path for text inputs.
  document.addEventListener(
    "change",
    (e) => {
      if (window.__rubatoMode !== "recording") return;
      const el = e.target;
      if (el.tagName === "SELECT") {
        record(makeStep("select", el, { value: el.value }));
      } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const type = inputType(el);
        if (type === "checkbox" || type === "radio") record(makeStep(el.checked ? "check" : "uncheck", el));
        else if (el.tagName === "TEXTAREA" || isTextLikeInput(el)) recordFill(el);
      }
    },
    true,
  );

  // Keys: record deliberate keys as `press` steps so complex keyboard-driven
  // interactions replay. Three cases, in priority order:
  //   1. A modifier shortcut (Ctrl/Cmd/Alt + key), e.g. Ctrl+S / Cmd+Enter — always
  //      meaningful; flush the field first so the value is filled before the combo.
  //   2. Enter / Tab / Escape — commit/cancel keys; flush the field, then the press.
  //   3. Navigation/editing keys (arrows, Home/End, PageUp/Down, Backspace, Delete)
  //      *outside* a text field — driving a custom widget (listbox, menu, grid).
  //      Inside a text field these just edit text, which the `fill` already captures.
  // Plain printable typing inside a field is left to the input→fill path.
  const COMMIT_KEYS = { Enter: 1, Tab: 1, Escape: 1 };
  const WIDGET_KEYS = {
    Enter: 1, Tab: 1, Escape: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
    Home: 1, End: 1, PageUp: 1, PageDown: 1, Backspace: 1, Delete: 1,
  };
  const MODIFIER_KEYS = { Control: 1, Shift: 1, Alt: 1, Meta: 1 };
  const comboString = (e) => {
    const parts = [];
    if (e.ctrlKey) parts.push("Control");
    if (e.metaKey) parts.push("Meta");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    parts.push(e.key);
    return parts.join("+");
  };
  document.addEventListener(
    "keydown",
    (e) => {
      if (window.__rubatoMode !== "recording") return;
      const el = e.target;
      if (MODIFIER_KEYS[e.key]) return; // a lone modifier press isn't an action
      const shortcut = e.ctrlKey || e.metaKey || e.altKey; // Shift alone isn't a shortcut
      if (shortcut) {
        flushPending();
        record(makeStep("press", el, { value: comboString(e) }));
        return;
      }
      if (COMMIT_KEYS[e.key]) {
        flushPending();
        record(makeStep("press", el, { value: e.key }));
        return;
      }
      if (!isTextEditable(el) && WIDGET_KEYS[e.key]) {
        record(makeStep("press", el, { value: e.key }));
      }
      // else: printable / editing key inside a field — captured by input→fill.
    },
    true,
  );
}.toString()})();`;

// ── command dispatch ────────────────────────────────────────────────────────
async function handle(msg) {
  const { id, cmd } = msg;
  try {
    switch (cmd) {
      case "launch":
        await launch(msg.headless, msg.url);
        return reply(id, { path: page.url() });
      case "goto":
        await page.goto(msg.url, { waitUntil: "domcontentloaded" });
        return reply(id);
      case "action": {
        // Scope captured logs to this step, and attach where-we-ended-up info to
        // every result. On failure also grab a screenshot of the page state.
        const mark = consoleBuf.length;
        try {
          const out = await execAction(msg.action, msg.target, msg.params, msg.timeout);
          // Per-step timeline capture: when the interpreter asks (meaningful steps),
          // let the result render then attach a frame (HTML + screenshot) of the page.
          if (msg.capture) {
            await settleAfterAction();
            const frame = await captureFrame();
            if (frame) {
              out.html = frame.html;
              out.screenshot = frame.screenshot;
            }
            // Drain the page network seen during the step (after settle, so the
            // requests this screen kicked off are included).
            const net = drainNetwork();
            if (net) out.network = net;
          }
          return reply(id, { ...out, ...diag(mark) });
        } catch (e) {
          return fail(id, e, { ...diag(mark), screenshot: await failureShot(), html: await pageHtml() });
        }
      }
      case "check-condition":
        return reply(id, { value: String(await checkCondition(msg.condition, msg.timeout ?? 5000)) });
      case "test-selector": {
        const loc = resolveLocator(page, msg.target);
        const count = await loc.count();
        const visible = count > 0 ? await loc.first().isVisible().catch(() => false) : false;
        if (count > 0) await loc.first().highlight().catch(() => {});
        return reply(id, { matchCount: count, value: String(visible) });
      }
      case "highlight":
        await resolveLocator(page, msg.target).first().highlight().catch(() => {});
        return reply(id);
      case "arm-picker":
        await setMode("picking");
        return reply(id);
      case "arm-recorder":
        await setMode("recording");
        return reply(id);
      case "arm-capture":
        // Capture builds on the recorder (records interactions) + per-event HTML/shots.
        capturing = true;
        captureSeq = 0;
        await setMode("recording");
        await emitCapture({ kind: "start" }); // bundle the initial screen
        return reply(id);
      case "set-capture":
        // Toggle artifact capture independently of stopping the recorder, so the
        // unified build session can flip "Capture screens" on/off mid-recording.
        // Capture builds on the recorder, so turning it on also ensures recording.
        // captureSeq is NOT reset here (it stays monotonic across on/off toggles)
        // so a session's manifest never gets two records with the same seq.
        if (msg.on) {
          if (mode !== "recording") await setMode("recording");
          if (!capturing) {
            capturing = true;
            await emitCapture({ kind: "start" }); // bundle the current screen
          }
        } else if (capturing) {
          await flushPendingCapture(); // record any in-progress edit before pausing
          capturing = false;
        }
        return reply(id);
      case "capture-frame":
        // Manual "snapshot now" while capturing (e.g. a read-only screen with no action).
        await emitCapture({ kind: "manual" });
        return reply(id);
      case "stop-mode":
        // Record any field still being edited when capture stops (the field never
        // blurs — the Stop button is in another window). Must run while capturing
        // is still true so the final frame is emitted.
        await flushPendingCapture();
        capturing = false;
        await setMode("idle");
        return reply(id);
      case "url":
        return reply(id, { path: page ? page.url() : "" });
      case "close":
        await closeBrowser();
        context = page = null;
        reply(id);
        emit({ event: "closed" });
        return;
      default:
        return fail(id, `unknown cmd: ${cmd}`);
    }
  } catch (e) {
    return fail(id, e);
  }
}

// ── stdin line loop ─────────────────────────────────────────────────────────
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

async function shutdown() {
  intentionalClose = true;
  await browser?.close().catch(() => {});
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Signal readiness so the Bun side knows the host is up.
send({ event: "ready" });
