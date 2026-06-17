/**
 * Bun-side wrapper around the Node Playwright host (src/scripts/browser-host.mjs).
 *
 * Playwright can't be driven from Bun, so we spawn `node browser-host.mjs` and
 * talk to it over a JSON-line stdio protocol: each command gets an incrementing
 * id and resolves the matching response; unsolicited host events (picker /
 * recorder / navigation) are handed to `onEvent`. Implements BrowserDriver so the
 * interpreter can run against it unchanged.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BrowserDriver } from '../lib/interpreter';
import { findPackageRoot } from '../lib/pkgPaths';
import type {
  ActionOutcome,
  Condition,
  HostCommand,
  HostEvent,
  HostResponse,
  LeafAction,
  StepParams,
  Target,
} from '../shared/automation';

// The Node host ships as raw .mjs in dev (src/scripts/) and is copied verbatim
// into dist/ when published — resolve whichever exists. A bun-COMPILED binary has
// neither src/ nor dist/ on disk (and no node_modules), so we also look beside the
// executable: a friend app that wants runs to work from its binary ships
// browser-host.mjs (and a `playwright` install) next to it. The probe + spawn use
// `cwd = dirname(HOST_SCRIPT)`, so a beside-the-binary node_modules resolves too.
const ROOT = findPackageRoot(import.meta.dir);
const HOST_SCRIPT =
  [
    resolve(dirname(process.execPath), 'browser-host.mjs'),
    resolve(ROOT, 'src/scripts/browser-host.mjs'),
    resolve(ROOT, 'dist/browser-host.mjs'),
  ].find(existsSync) ?? resolve(ROOT, 'src/scripts/browser-host.mjs');

/**
 * The `node` to drive Playwright with. A bun-COMPILED app can bundle a Node binary
 * so end users install nothing: prefer `RUBATO_NODE`, then a `node` (or
 * `runtime/node`) beside the executable, then one on PATH. Null if none is found.
 */
function resolveNode(): string | null {
  const fromEnv = process.env.RUBATO_NODE?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const dir = dirname(process.execPath);
  // `node.exe` on Windows; bare `node` elsewhere. Check both (+ a `runtime/` subdir)
  // so a bundled Node beside the binary is found on every OS.
  const beside = [
    resolve(dir, 'node'),
    resolve(dir, 'node.exe'),
    resolve(dir, 'runtime', 'node'),
    resolve(dir, 'runtime', 'node.exe'),
  ].find(existsSync);
  return beside ?? Bun.which('node');
}

/**
 * If a Playwright browser set is bundled beside the binary (a `browsers/` dir),
 * point Playwright at it — so runs need no system browser and no `playwright
 * install`. A user-set `PLAYWRIGHT_BROWSERS_PATH` always wins.
 */
function applyBundledBrowsers(): void {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  const beside = resolve(dirname(process.execPath), 'browsers');
  if (existsSync(beside)) process.env.PLAYWRIGHT_BROWSERS_PATH = beside;
}

// The host exits with this code when a headed browser is closed by the user (not
// by us) — see browser-host.mjs. Kept in sync by hand across the stdio boundary.
const EXIT_BROWSER_CLOSED = 75;

/**
 * A failed host action. Carries the diagnostics the host gathered at the moment
 * of failure (final URL, console logs, a screenshot) so the interpreter can fold
 * them into the StepResult. The message stays the plain error string.
 */
export class HostActionError extends Error {
  constructor(
    message: string,
    public outcome?: ActionOutcome,
  ) {
    super(message);
    this.name = 'HostActionError';
  }
}

type Pending = { resolve: (o: ActionOutcome) => void; reject: (e: Error) => void };

/** Distribute Omit over the HostCommand union so each variant keeps its fields. */
type HostCommandNoId = HostCommand extends infer C ? (C extends { id: number } ? Omit<C, 'id'> : never) : never;

export class BrowserHost implements BrowserDriver {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private readyPromise: Promise<void>;
  // Set once the Node host has exited (or been killed). Guards against settling
  // twice and lets new commands reject immediately instead of hanging.
  private exited = false;
  /**
   * Called once when the host process is gone, however it happened (crash, our
   * own kill, or the user closing a headed window). Lets a caller holding the
   * browser open react to it being closed out from under them — e.g. clear the
   * "browser kept open" banner. Set after start(); fires at most once.
   */
  onExit: ((code: number | null) => void) | null = null;

  constructor(private onEvent: (e: HostEvent) => void = () => {}) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  /** Spawn the host and wait until it signals `ready`. */
  async start(): Promise<void> {
    if (this.proc) return this.readyPromise;
    // Playwright runs under Node, not Bun — fail with an actionable message if it's
    // absent. A bundled Node beside the binary (or RUBATO_NODE) satisfies this too.
    const node = resolveNode();
    if (!node) {
      throw new Error(
        "Node.js is required to drive the browser (Playwright can't run under Bun). " +
          'Install Node and put it on your PATH, ship a `node` beside the app, or set RUBATO_NODE.',
      );
    }
    // Use a bundled browser set if one sits beside the binary (zero-install distros).
    applyBundledBrowsers();
    // 'playwright' is an OPTIONAL peer dep (heavy: bundles browser binaries). The
    // Node host imports it; probe its resolvability the same way Node will (from
    // the host script's dir) so we fail with an actionable message here rather than
    // letting the subprocess die on a raw ERR_MODULE_NOT_FOUND.
    const probe = Bun.spawnSync([node, '-e', "require.resolve('playwright')"], {
      cwd: dirname(HOST_SCRIPT),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    if (probe.exitCode !== 0) {
      throw new Error(
        "Browser automations need the optional 'playwright' package, which isn't installed. " +
          'Run `bun add playwright` — then either use your system Google Chrome (the default) ' +
          'or run `bunx playwright install chromium` for the bundled browser.',
      );
    }
    this.proc = Bun.spawn([node, HOST_SCRIPT], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
    this.readStdout();
    // If the host dies (crash, or the user closes a headed browser and it takes
    // the process down), settle the ready gate and reject every in-flight command
    // — otherwise an awaiting run would hang forever and never emit a result.
    this.proc.exited.then(
      (code) => this.handleExit(code),
      () => this.handleExit(null),
    );
    await this.readyPromise;
  }

  /** Whether the host process is still up (and its browser still connected). */
  get alive(): boolean {
    return !this.exited && this.proc !== null;
  }

  /** Settle everything outstanding when the host process is gone. Idempotent. */
  private handleExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    // The host exits with EXIT_BROWSER_CLOSED when the user closes a headed window
    // out from under a run; surface that as a clean failure rather than a raw code.
    const msg =
      code === EXIT_BROWSER_CLOSED
        ? 'the browser was closed'
        : `browser host exited${code == null ? '' : ` (code ${code})`}`;
    this.readyReject?.(new Error(msg));
    const err = new HostActionError(msg);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    // Notify a holder (e.g. the engine keeping a failed run's window open) that
    // the browser is gone — after settling commands so its handler sees a quiet
    // host. Best-effort: a throwing handler must not mask the exit.
    try {
      this.onExit?.(code);
    } catch {
      // ignore handler errors
    }
  }

  private async readStdout(): Promise<void> {
    const stream = this.proc?.stdout;
    if (!stream || typeof stream === 'number') return;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        // Stream closed → the host is gone; don't leave commands hanging.
        this.handleExit(this.proc?.exitCode ?? null);
        break;
      }
      this.buf += dec.decode(value, { stream: true });
      for (;;) {
        const nl = this.buf.indexOf('\n');
        if (nl < 0) break;
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) this.route(line);
      }
    }
  }

  private route(line: string): void {
    let msg: HostResponse | HostEvent;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if ('id' in msg) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new HostActionError(msg.error, msg.outcome));
      return;
    }
    if (msg.event === 'ready') this.readyResolve?.();
    else this.onEvent(msg);
  }

  private command(partial: HostCommandNoId): Promise<ActionOutcome> {
    if (this.exited) return Promise.reject(new HostActionError('browser host exited'));
    if (!this.proc) throw new Error('browser host not started');
    const id = this.nextId++;
    const promise = new Promise<ActionOutcome>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      const sink = this.proc.stdin as { write: (s: string) => void; flush: () => void };
      sink.write(`${JSON.stringify({ id, ...partial })}\n`);
      sink.flush();
    } catch (e) {
      // Writing to a dead host's stdin throws — fail this command rather than
      // leaving its promise pending forever.
      this.pending.delete(id);
      return Promise.reject(new HostActionError(e instanceof Error ? e.message : String(e)));
    }
    return promise;
  }

  // ── BrowserDriver ─────────────────────────────────────────────────────────
  exec(
    action: LeafAction,
    target: Target | undefined,
    params: StepParams,
    timeout?: number,
    capture?: boolean,
  ): Promise<ActionOutcome> {
    return this.command({ cmd: 'action', action, target, params, timeout, capture });
  }

  async condition(cond: Condition, timeout?: number): Promise<boolean> {
    const out = await this.command({ cmd: 'check-condition', condition: cond, timeout });
    return out.value === 'true';
  }

  // ── build-session helpers ─────────────────────────────────────────────────
  launch(headless: boolean, url?: string): Promise<ActionOutcome> {
    return this.command({ cmd: 'launch', headless, url });
  }
  goto(url: string): Promise<ActionOutcome> {
    return this.command({ cmd: 'goto', url });
  }
  async testSelector(target: Target): Promise<{ matchCount: number; visible: boolean }> {
    const out = await this.command({ cmd: 'test-selector', target });
    return { matchCount: out.matchCount ?? 0, visible: out.value === 'true' };
  }
  highlight(target: Target): Promise<ActionOutcome> {
    return this.command({ cmd: 'highlight', target });
  }
  armPicker(): Promise<ActionOutcome> {
    return this.command({ cmd: 'arm-picker' });
  }
  armRecorder(): Promise<ActionOutcome> {
    return this.command({ cmd: 'arm-recorder' });
  }
  /** Start capture/data-gathering mode (records interactions + bundles HTML + screenshots). */
  armCapture(): Promise<ActionOutcome> {
    return this.command({ cmd: 'arm-capture' });
  }
  /** Toggle artifact capture on/off without stopping the recorder (unified session). */
  setCapture(on: boolean): Promise<ActionOutcome> {
    return this.command({ cmd: 'set-capture', on });
  }
  /** Bundle the current screen on demand (a manual "snapshot now" while capturing). */
  captureFrame(): Promise<ActionOutcome> {
    return this.command({ cmd: 'capture-frame' });
  }
  stopMode(): Promise<ActionOutcome> {
    return this.command({ cmd: 'stop-mode' });
  }
  async currentUrl(): Promise<string> {
    const out = await this.command({ cmd: 'url' });
    return out.path ?? '';
  }
  async close(): Promise<void> {
    await this.command({ cmd: 'close' }).catch(() => {});
  }

  /** Kill the Node subprocess (closing its stdin makes it exit cleanly too). */
  kill(): void {
    try {
      this.proc?.kill();
    } catch {
      // already gone
    }
    // Settle anything outstanding now — the async `exited` handler may lag, and a
    // command issued in between must not hang.
    this.handleExit(this.proc?.exitCode ?? null);
    this.proc = null;
  }
}
