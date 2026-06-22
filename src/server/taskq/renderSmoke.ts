/**
 * Headless UI render smoke for the promotion gate — the anti-WHITE-SCREEN layer that
 * neither `bun run build` nor the runtime boot smoke (`bootSmoke.ts`) can catch.
 *
 * The gate's three independent signals, in increasing fidelity:
 *   1. `bun run build`  — proves the bundle TYPE-checks + BUNDLES.
 *   2. boot smoke       — proves the server BOOTS + answers `/api/health`.
 *   3. render smoke (here) — proves the bundle actually RENDERS in a browser.
 *
 * A green build + a healthy server can still WHITE-SCREEN the user: two React copies
 * (a `resolve.dedupe` gap → a null hook dispatcher), a runtime mount throw, or a missing
 * context provider blow up only once the bundle is parsed + mounted in a real browser —
 * exactly the incident this hardens against (ru white-screened with a green tsc). So this
 * module boots the served UI, drives a HEADLESS browser at it, and asserts (a) the React
 * root element actually MOUNTED (non-empty), and (b) no fatal console errors / uncaught
 * page exceptions fired during load.
 *
 * Same split as the rest of the gate: a PURE plan + decision (`planRenderSmoke` /
 * `rubatoRenderSmokeSpec` / `decideRender` — fully unit-testable, no spawning) and an
 * impure `runRenderSmoke` that boots the server (cwip/testing's hardened `startTestServer`,
 * the same primitive the functional testkit + boot smoke use — not a per-app reimpl) and
 * spawns the Node Playwright host (`render-smoke-host.mjs` — Playwright cannot be driven
 * from Bun, so it runs in a `node` subprocess; see `browser-host.mjs`). Both seams are
 * injected so unit tests never touch a real browser or server.
 *
 * `ran` vs `ok` is deliberate: a render check that CANNOT run (no node / no Playwright /
 * the server never booted) reports `ran:false` and must NOT block the gate (it degrades to
 * the build+boot signal, exactly like an absent boot-smoke helper); only a check that ran
 * and saw a white screen / fatal error reports `ran:true, ok:false` → RED.
 */
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type StartTestServerOptions, startTestServer } from 'cwip/testing';

/** The resolved, ready-to-run plan for one repo's render smoke. */
export interface RenderSmokeSpec {
  /** taskq repo alias (`ru`, `ca`, …) — labels the result. */
  repo: string;
  /** Command + args to boot the server that serves the built UI (e.g. `['bun','run','src/scripts/serve.ts']`). */
  cmd: string[];
  /** Working dir for the spawned server — the integration worktree to render-check. */
  cwd: string;
  /** Port the server binds; also builds the page + health URLs. */
  port: number;
  /** Health endpoint to wait for before opening the browser (default `/api/health`). */
  healthPath: string;
  /** Env var that relocates the app's ENTIRE state footprint (the isolation knob). */
  homeEnvVar: string;
  /** The throwaway dir that env var points at (created before boot, removed after). */
  homeDir: string;
  /** Env var that sets the listen port. */
  portEnvVar: string;
  /** Max ms to wait for the server to become healthy (the boot bound). */
  timeoutMs: number;
  /** Extra env merged over the isolation vars (e.g. `NODE_ENV`). */
  extraEnv?: Record<string, string>;
  /** Treat a health Response as ready (default: 2xx). */
  isHealthy?: (res: Response) => boolean | Promise<boolean>;
  /** Path the browser opens (default `/` — the SPA entry). */
  urlPath: string;
  /** Selector for the React root element whose mount we assert (default `#root`). */
  rootSelector: string;
  /** Max ms to wait for the page to navigate + the root to mount (the browser bound). */
  navTimeoutMs: number;
  /**
   * Console-error substrings (case-insensitive) that are KNOWN-BENIGN and ignored — so a
   * stray favicon 404 or a dev websocket reconnect never reds the gate. Everything else
   * at console-error level (and EVERY uncaught page exception) is fatal. Keep this list
   * tight: the whole point is to surface the noisy runtime breaks a white screen produces.
   */
  ignoreConsole: string[];
}

/** Caller-supplied inputs; everything else is defaulted by {@link planRenderSmoke}. */
export interface RenderSmokeSpecInput {
  repo: string;
  cmd: string[];
  cwd: string;
  /** Bind port — REQUIRED (kept pure/deterministic); see {@link pickFreePort}. */
  port: number;
  /** Isolated home — REQUIRED; see {@link renderSmokeHomeDir}. */
  homeDir: string;
  homeEnvVar: string;
  portEnvVar: string;
  healthPath?: string;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
  isHealthy?: (res: Response) => boolean | Promise<boolean>;
  urlPath?: string;
  rootSelector?: string;
  navTimeoutMs?: number;
  ignoreConsole?: string[];
}

const DEFAULT_BOOT_TIMEOUT_MS = 45_000;
const DEFAULT_NAV_TIMEOUT_MS = 20_000;
/** Benign-by-default console noise a healthy app still emits (kept deliberately small). */
export const DEFAULT_IGNORE_CONSOLE = ['favicon', 'failed to load resource: the server responded with a status of 404'];

/** Pure: fill defaults to produce a complete, runnable {@link RenderSmokeSpec}. */
export function planRenderSmoke(input: RenderSmokeSpecInput): RenderSmokeSpec {
  return {
    repo: input.repo,
    cmd: input.cmd,
    cwd: input.cwd,
    port: input.port,
    healthPath: input.healthPath ?? '/api/health',
    homeEnvVar: input.homeEnvVar,
    homeDir: input.homeDir,
    portEnvVar: input.portEnvVar,
    timeoutMs: input.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
    extraEnv: input.extraEnv,
    isHealthy: input.isHealthy,
    urlPath: input.urlPath ?? '/',
    rootSelector: input.rootSelector ?? '#root',
    navTimeoutMs: input.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS,
    ignoreConsole: input.ignoreConsole ?? DEFAULT_IGNORE_CONSOLE,
  };
}

/**
 * Pure: the env the spawned server runs under — the isolation knobs (home + port) plus
 * any extras. The home var relocates ALL of the app's state to a throwaway dir, so the
 * smoke never reads or writes the real `~/.rubato` (or ca's equivalent).
 */
export function renderSmokeEnv(spec: RenderSmokeSpec): Record<string, string> {
  return { [spec.homeEnvVar]: spec.homeDir, [spec.portEnvVar]: String(spec.port), ...spec.extraEnv };
}

/**
 * The rubato (`ru`) preset: boot `rubato-serve` (which serves the built `ui/dist`) from an
 * integration worktree, isolated via `RUBATO_HOME` + `RUBATO_PORT`, then render-check `/`.
 * Run AFTER `bun run build` so the real bundle is what gets mounted. The gate passes the
 * integration worktree dir as `cwd`, a free `port`, and a throwaway `homeDir`.
 */
export function rubatoRenderSmokeSpec(opts: {
  cwd: string;
  port: number;
  homeDir: string;
  timeoutMs?: number;
  navTimeoutMs?: number;
}): RenderSmokeSpec {
  return planRenderSmoke({
    repo: 'ru',
    // No `--hot`: a smoke wants a clean one-shot boot serving the built bundle.
    cmd: ['bun', 'run', 'src/scripts/serve.ts'],
    cwd: opts.cwd,
    homeEnvVar: 'RUBATO_HOME',
    portEnvVar: 'RUBATO_PORT',
    port: opts.port,
    homeDir: opts.homeDir,
    healthPath: '/api/health',
    timeoutMs: opts.timeoutMs,
    navTimeoutMs: opts.navTimeoutMs,
  });
}

/**
 * The cursedalchemy (`ca`) preset — best-effort scaffold mirroring `rubatoRenderSmokeSpec`
 * with ca's own home/port env vars + server entry. Like ca's BOOT smoke (see
 * `fu-intgate-smoke-ca`), ca render-smoke stays OPT-IN until verified in the ca repo
 * itself — its multi-workspace boot needs an isolated data dir + port confirmed there
 * first, so the gate doesn't freeze on an unverified spec. Override any field as needed.
 */
export function caRenderSmokeSpec(opts: {
  cwd: string;
  port: number;
  homeDir: string;
  cmd?: string[];
  homeEnvVar?: string;
  portEnvVar?: string;
  healthPath?: string;
  timeoutMs?: number;
  navTimeoutMs?: number;
  extraEnv?: Record<string, string>;
}): RenderSmokeSpec {
  return planRenderSmoke({
    repo: 'ca',
    cmd: opts.cmd ?? ['bun', 'run', 'src/scripts/serve.ts'],
    cwd: opts.cwd,
    homeEnvVar: opts.homeEnvVar ?? 'CA_DATA_DIR',
    portEnvVar: opts.portEnvVar ?? 'PORT',
    port: opts.port,
    homeDir: opts.homeDir,
    healthPath: opts.healthPath ?? '/api/health',
    timeoutMs: opts.timeoutMs,
    navTimeoutMs: opts.navTimeoutMs,
    extraEnv: opts.extraEnv,
  });
}

/**
 * What the Node Playwright host reports back about one page load. `launched:false` means
 * the browser could not even start (no node / no Playwright / a host crash) — an
 * INCONCLUSIVE result the gate must NOT treat as a white screen.
 */
export interface RenderProbe {
  /** Did a browser actually launch? `false` ⇒ the check could not run (inconclusive). */
  launched: boolean;
  /** Did the page navigate to the URL (no nav error / timeout)? */
  navigated: boolean;
  /** Was the root selector present in the DOM after load? */
  rootFound: boolean;
  /** Trimmed `innerHTML` length of the root element — `0` ⇒ an empty (un-mounted) root. */
  rootHtmlLength: number;
  /** Text of every console message logged at `error` level during load. */
  consoleErrors: string[];
  /** Messages of every UNCAUGHT page exception (`pageerror`) during load. */
  pageErrors: string[];
  /** Host-level failure detail when the browser couldn't launch / a fatal host error. */
  error?: string;
}

/** The verdict of evaluating a {@link RenderProbe} against a spec's ignore list. */
export interface RenderVerdict {
  /** Did the check RUN to a conclusion (browser launched + navigated)? */
  ran: boolean;
  /** Did the app render cleanly (root mounted, no fatal errors)? Meaningless when `!ran`. */
  ok: boolean;
  /** Human-readable summary (the success line, or the white-screen / error reason). */
  detail: string;
  /** Console-error messages that survived the ignore filter (the fatal ones). */
  fatalConsole: string[];
}

const norm = (s: string) => s.toLowerCase();
/** True when a console message matches any benign-ignore substring (case-insensitive). */
export function isIgnoredConsole(message: string, ignore: string[]): boolean {
  const m = norm(message);
  return ignore.some((p) => p && m.includes(norm(p)));
}

/**
 * PURE: turn a {@link RenderProbe} into a {@link RenderVerdict}. The white-screen ladder:
 *  - couldn't launch a browser            → inconclusive (`ran:false`) — never blocks.
 *  - launched but never navigated         → RED (page unreachable).
 *  - navigated but root empty / absent    → RED (WHITE SCREEN — React never mounted).
 *  - mounted but a fatal console / page error fired → RED.
 *  - mounted, clean                       → GREEN.
 */
export function decideRender(probe: RenderProbe, spec: Pick<RenderSmokeSpec, 'rootSelector' | 'ignoreConsole'>): RenderVerdict {
  if (!probe.launched) {
    return { ran: false, ok: false, detail: `render check could not run: ${probe.error ?? 'browser did not launch'}`, fatalConsole: [] };
  }
  if (!probe.navigated) {
    return { ran: true, ok: false, detail: `page never loaded${probe.error ? `: ${probe.error}` : ''}`, fatalConsole: [] };
  }
  if (!probe.rootFound || probe.rootHtmlLength <= 0) {
    return {
      ran: true,
      ok: false,
      detail: `WHITE SCREEN — React root (${spec.rootSelector}) ${probe.rootFound ? 'is empty' : 'is missing'} after load (it never mounted)`,
      fatalConsole: [],
    };
  }
  const fatalConsole = probe.consoleErrors.filter((m) => !isIgnoredConsole(m, spec.ignoreConsole));
  const fatal = [...fatalConsole, ...probe.pageErrors];
  if (fatal.length > 0) {
    return {
      ran: true,
      ok: false,
      detail: `root mounted (${probe.rootHtmlLength} bytes) but ${fatal.length} fatal error(s); first: ${fatal[0]}`,
      fatalConsole,
    };
  }
  return {
    ran: true,
    ok: true,
    detail: `React root mounted (${probe.rootHtmlLength} bytes); no fatal console/page errors`,
    fatalConsole: [],
  };
}

/** The outcome of one repo's render smoke. */
export interface RenderSmokeResult {
  repo: string;
  /** Did the check run to a conclusion (browser launched + navigated)? */
  ran: boolean;
  /** Did the app render cleanly? Only meaningful when `ran` (an inconclusive run is `ok:false, ran:false`). */
  ok: boolean;
  /** Human-readable summary. */
  detail: string;
  /** Last lines of the booted server's output (gold when the page errors trace back to the API). */
  logTail?: string;
  /** The raw probe, for diagnostics. */
  probe?: RenderProbe;
  durationMs: number;
}

/** Injectable seams so `runRenderSmoke` is unit-testable without a real process/browser. */
export interface RenderSmokeDeps {
  startServer?: (opts: StartTestServerOptions) => Promise<{ logs(): string[]; stop(): Promise<void> }>;
  /** Drive a headless browser at `url` and report a {@link RenderProbe}. Defaults to the Node host. */
  runProbe?: (url: string, spec: RenderSmokeSpec) => Promise<RenderProbe>;
  ensureDir?: (dir: string) => Promise<void>;
  removeDir?: (dir: string) => Promise<void>;
  now?: () => number;
}

/**
 * Boot the server, render-check the page in a headless browser, tear everything down —
 * returning a structured pass/fail. NEVER throws: a boot failure, a host crash, or a
 * white screen all come back as a {@link RenderSmokeResult} (the gate treats a check that
 * can't run as inconclusive, not a crash). Always removes the throwaway home dir.
 */
export async function runRenderSmoke(spec: RenderSmokeSpec, deps: RenderSmokeDeps = {}): Promise<RenderSmokeResult> {
  const startServer = deps.startServer ?? startTestServer;
  const runProbe = deps.runProbe ?? defaultRunProbe;
  const ensureDir = deps.ensureDir ?? ((dir: string) => mkdir(dir, { recursive: true }).then(() => undefined));
  const removeDir = deps.removeDir ?? ((dir: string) => rm(dir, { recursive: true, force: true }));
  const now = deps.now ?? (() => Date.now());

  const started = now();
  const elapsed = () => now() - started;

  try {
    await ensureDir(spec.homeDir);
  } catch (e) {
    // Can't prep the isolation dir → inconclusive (don't block the gate on an fs hiccup).
    return { repo: spec.repo, ran: false, ok: false, detail: `failed to create isolated home: ${errMsg(e)}`, durationMs: elapsed() };
  }

  let server: { logs(): string[]; stop(): Promise<void> } | undefined;
  try {
    server = await startServer({
      cmd: spec.cmd,
      cwd: spec.cwd,
      port: spec.port,
      env: renderSmokeEnv(spec),
      healthPath: spec.healthPath,
      timeoutMs: spec.timeoutMs,
      isHealthy: spec.isHealthy,
    });
  } catch (e) {
    // The server never booted — that's a BOOT failure (the boot smoke's job), reported
    // as inconclusive here so render-smoke doesn't double-count it as a white screen.
    return {
      repo: spec.repo,
      ran: false,
      ok: false,
      detail: `server did not boot for render smoke: ${errMsg(e)}`,
      logTail: server ? tailLines((server as { logs(): string[] }).logs()) : undefined,
      durationMs: elapsed(),
    };
  }

  try {
    const url = `http://127.0.0.1:${spec.port}${spec.urlPath}`;
    const probe = await runProbe(url, spec);
    const verdict = decideRender(probe, spec);
    return {
      repo: spec.repo,
      ran: verdict.ran,
      ok: verdict.ok,
      detail: verdict.detail,
      logTail: tailLines(server.logs()),
      probe,
      durationMs: elapsed(),
    };
  } catch (e) {
    // A probe that throws is a tooling failure, not a proven white screen → inconclusive.
    return {
      repo: spec.repo,
      ran: false,
      ok: false,
      detail: `render probe errored: ${errMsg(e)}`,
      logTail: tailLines(server.logs()),
      durationMs: elapsed(),
    };
  } finally {
    try {
      await server?.stop();
    } catch {
      /* best-effort */
    }
    try {
      await removeDir(spec.homeDir);
    } catch {
      /* best-effort */
    }
  }
}

/** Sentinel the Node host prefixes its single result line with, so we can find it amid noise. */
export const RENDER_PROBE_SENTINEL = 'RENDER_SMOKE_PROBE:';

/**
 * Parse the Node host's stdout into a {@link RenderProbe}. The host prints exactly one
 * `RENDER_SMOKE_PROBE:{…}` line; if it's absent (the host crashed before emitting), we
 * return an inconclusive probe carrying the captured stderr tail.
 */
export function parseProbe(stdout: string, stderr = ''): RenderProbe {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.includes(RENDER_PROBE_SENTINEL));
  if (line) {
    try {
      const json = line.slice(line.indexOf(RENDER_PROBE_SENTINEL) + RENDER_PROBE_SENTINEL.length).trim();
      const p = JSON.parse(json) as Partial<RenderProbe>;
      return {
        launched: !!p.launched,
        navigated: !!p.navigated,
        rootFound: !!p.rootFound,
        rootHtmlLength: typeof p.rootHtmlLength === 'number' ? p.rootHtmlLength : 0,
        consoleErrors: Array.isArray(p.consoleErrors) ? p.consoleErrors.map(String) : [],
        pageErrors: Array.isArray(p.pageErrors) ? p.pageErrors.map(String) : [],
        error: p.error,
      };
    } catch {
      /* fall through to the inconclusive shape */
    }
  }
  return {
    launched: false,
    navigated: false,
    rootFound: false,
    rootHtmlLength: 0,
    consoleErrors: [],
    pageErrors: [],
    error: `no render result emitted${stderr.trim() ? `: ${tailLines(stderr.split('\n'), 6)}` : ''}`,
  };
}

/** Absolute path to the Node Playwright host (resolved from this module's location). */
export function renderHostPath(): string {
  return fileURLToPath(new URL('../../scripts/render-smoke-host.mjs', import.meta.url));
}

/**
 * Default probe: spawn the Node Playwright host (`render-smoke-host.mjs`) — Playwright
 * cannot be driven from Bun, so it runs under `node` — and parse its single result line.
 * Never throws: a spawn error becomes an inconclusive probe.
 */
async function defaultRunProbe(url: string, spec: RenderSmokeSpec): Promise<RenderProbe> {
  try {
    const proc = Bun.spawn(
      ['node', renderHostPath(), '--url', url, '--root', spec.rootSelector, '--timeout', String(spec.navTimeoutMs)],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
    );
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return parseProbe(out, err);
  } catch (e) {
    return { launched: false, navigated: false, rootFound: false, rootHtmlLength: 0, consoleErrors: [], pageErrors: [], error: errMsg(e) };
  }
}

/** A throwaway, per-run isolated home dir for a repo's render smoke (under the OS tmpdir). */
export function renderSmokeHomeDir(repo: string, seed: string | number = process.pid): string {
  return join(tmpdir(), `intgate-render-${repo}-${seed}`);
}

/**
 * Ask the OS for a free ephemeral TCP port (bind :0, read the assigned port, close).
 * A tiny race exists between close and the server's bind, but for a local smoke that's
 * acceptable — far better than a hardcoded port that collides with a running app.
 */
export async function pickFreePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not pick a free port'))));
    });
  });
}

function tailLines(lines: string[], n = 25): string {
  return lines
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
