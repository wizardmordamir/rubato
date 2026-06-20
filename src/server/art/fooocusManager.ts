/**
 * Start/stop/status for the two local Fooocus servers, driving the chat-page
 * control panel:
 *   - `api` → Fooocus-API (default :8888), the JSON backend the art engine calls.
 *   - `ui`  → the standalone Fooocus Gradio web UI (default :7865).
 *
 * Design notes:
 * - **Status is a live port probe**, not PID bookkeeping — so an instance you
 *   started by hand is reflected as "running" too. We additionally remember
 *   whether *rubato* spawned the process this session ("managed"); that's the
 *   only case rubato will stop it. An externally-started server is left alone.
 * - **Discovery + graceful failure.** The install dir is auto-found by probing
 *   known locations and the dir's own `.venv/bin/python3`; `~/.rubato/config.json`
 *   → `fooocus.{api,ui}` can override any field. If Fooocus isn't on disk the
 *   server reports `installed:false` (the toggle disables) instead of throwing —
 *   so deleting Fooocus degrades cleanly.
 * - Processes are detached (`unref`) and log to `<RUBATO_HOME>/logs/fooocus-*.log`
 *   so a failed boot is diagnosable.
 *
 * Spec resolution is dependency-injectable (`exists`, `candidateDirs`) so the
 * discovery logic is unit-tested without touching the real filesystem.
 */

import { existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FooocusServerOverride } from '../../lib/appApis';
import { expandPath, loadConfig, RUBATO_HOME } from '../../lib/config';
import { type FooocusServerId, type FooocusServerStatus, type FooocusStatus, memoryArgs } from '../../shared/fooocus';

/** Static per-server metadata + discovery defaults. */
const META: Record<FooocusServerId, { label: string; port: number; entry: string; dirs: string[]; probePath: string }> =
  {
    api: {
      label: 'Fooocus API',
      port: 8888,
      entry: 'main.py',
      // Known install locations, most-specific first. A candidate counts only if
      // its entry script exists, so the empty `~/Fooocus-API` stub is skipped.
      dirs: ['~/code/generalCode/pythonCode/Fooocus-API', '~/Fooocus-API', '~/Fooocus_API'],
      probePath: '/ping',
    },
    ui: {
      label: 'Fooocus Web UI',
      port: 7865,
      entry: 'launch.py',
      dirs: ['~/code/generalCode/pythonCode/Fooocus', '~/Fooocus'],
      probePath: '/',
    },
  };

/** Fully-resolved launch spec for one server. */
export interface FooocusSpec {
  id: FooocusServerId;
  label: string;
  port: number;
  url: string;
  probePath: string;
  /** Install dir whose entry script exists, or null when not found. */
  dir: string | null;
  /** Interpreter to launch with (absolute venv python, a fallback, or `python3`). */
  python: string;
  /** Args after the interpreter, e.g. ['main.py'] or ['launch.py','--port','7865']. */
  args: string[];
}

/**
 * Resolve a python interpreter override. A path (has a slash or `~`) is
 * tilde-expanded/absolutized; a bare command name (e.g. `python3`) is left as-is
 * so Bun.spawn looks it up on PATH instead of treating it as a cwd-relative file.
 */
function resolveInterpreter(p: string): string {
  return p.startsWith('~') || p.includes('/') ? expandPath(p) : p;
}

interface ResolveOpts {
  /** Python to fall back to when the dir has no `.venv` (e.g. the API's venv). */
  fallbackPython?: string | null;
  /** Override the candidate dir list (tests). Defaults to META[id].dirs. */
  candidateDirs?: string[];
  /** Existence check (tests). Defaults to fs.existsSync. */
  exists?: (p: string) => boolean;
  /** Extra launch flags appended last (e.g. memory/VRAM flags from `fooocus.memory`). */
  extraArgs?: string[];
}

/**
 * Resolve a server's launch spec from optional config overrides + discovery.
 * Pure aside from the injected `exists` check, so it's unit-testable.
 */
export function resolveFooocusSpec(
  id: FooocusServerId,
  override: FooocusServerOverride | undefined,
  opts: ResolveOpts = {},
): FooocusSpec {
  const meta = META[id];
  const exists = opts.exists ?? existsSync;
  const entry = override?.entry ?? meta.entry;
  const port = override?.port ?? meta.port;

  // An explicit `dir` override pins the search to that one location (no silent
  // fallback to a different discovered install); otherwise probe known dirs.
  const candidateDirs = override?.dir ? [override.dir] : (opts.candidateDirs ?? meta.dirs);
  const candidates = candidateDirs.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map(expandPath);
  const dir = candidates.find((d) => exists(resolve(d, entry))) ?? null;

  const venvPython = dir ? resolve(dir, '.venv/bin/python3') : null;
  const python = override?.python
    ? resolveInterpreter(override.python)
    : venvPython && exists(venvPython)
      ? venvPython
      : (opts.fallbackPython ?? 'python3');

  // Gradio needs an explicit --port; the API takes its port from its own config.
  // Memory/VRAM flags (opts.extraArgs) go last so an explicit `args` override can
  // still precede them; both Fooocus and Fooocus-API share the same arg parser.
  const baseArgs = id === 'ui' ? [entry, '--port', String(port)] : [entry];
  const args = [...baseArgs, ...(override?.args ?? []), ...(opts.extraArgs ?? [])];

  return { id, label: meta.label, port, url: `http://localhost:${port}`, probePath: meta.probePath, dir, python, args };
}

/** Resolve both servers. The UI borrows the API's venv python when it lacks one. */
async function resolveSpecs(): Promise<Record<FooocusServerId, FooocusSpec>> {
  const cfg = (await loadConfig()).fooocus ?? {};
  // Memory/VRAM flags apply to whichever Fooocus process runs — append to both.
  const extraArgs = memoryArgs(cfg.memory);
  const api = resolveFooocusSpec('api', cfg.api, { extraArgs });
  // The standalone Fooocus dir usually has no venv of its own; the API's venv
  // (torch/gradio installed) is the interpreter that actually works here.
  const apiVenv = api.python.endsWith('/.venv/bin/python3') ? api.python : null;
  const ui = resolveFooocusSpec('ui', cfg.ui, { fallbackPython: apiVenv, extraArgs });
  return { api, ui };
}

// ---- Live process registry (this server session only) -----------------------

interface Managed {
  proc: ReturnType<typeof Bun.spawn>;
}
const procs: Partial<Record<FooocusServerId, Managed>> = {};
const lastError: Partial<Record<FooocusServerId, string>> = {};
const stopping = new Set<FooocusServerId>();

const LOG_DIR = resolve(RUBATO_HOME, 'logs');
const logPath = (id: FooocusServerId): string => resolve(LOG_DIR, `fooocus-${id}.log`);

function isManaged(id: FooocusServerId): boolean {
  const m = procs[id];
  return !!m && !m.proc.killed;
}

/** True when the port answers any HTTP response within the timeout. */
async function probe(spec: FooocusSpec, timeoutMs = 1500): Promise<boolean> {
  try {
    await fetch(`${spec.url}${spec.probePath}`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return true; // any response (even 404) means something is listening
  } catch {
    return false;
  }
}

async function statusFor(spec: FooocusSpec): Promise<FooocusServerStatus> {
  const running = await probe(spec);
  const managed = isManaged(spec.id);
  return {
    id: spec.id,
    label: spec.label,
    port: spec.port,
    url: spec.url,
    running,
    managed,
    starting: managed && !running, // spawned by us but not yet answering
    installed: spec.dir !== null,
    dir: spec.dir,
    error: lastError[spec.id],
  };
}

export async function getFooocusStatus(): Promise<FooocusStatus> {
  const specs = await resolveSpecs();
  const [api, ui] = await Promise.all([statusFor(specs.api), statusFor(specs.ui)]);
  return { api, ui };
}

/**
 * Start a server. Idempotent and safe:
 *  - already answering (even if started outside rubato) → leave it, don't double-start.
 *  - not installed → record a friendly error, don't throw.
 *  - otherwise spawn detached, logging to `<RUBATO_HOME>/logs/fooocus-<id>.log`.
 * Returns immediately (the model load can take a while); the panel polls until
 * the port comes up.
 */
export async function startFooocus(id: FooocusServerId): Promise<FooocusStatus> {
  const spec = (await resolveSpecs())[id];

  if (await probe(spec)) return getFooocusStatus(); // already running — ignore
  if (isManaged(id)) return getFooocusStatus(); // spawned, still booting

  if (!spec.dir) {
    lastError[id] =
      `${spec.label} isn't installed where rubato can find it. Set fooocus.${id}.dir in ~/.rubato/config.json.`;
    return getFooocusStatus();
  }

  try {
    delete lastError[id];
    mkdirSync(LOG_DIR, { recursive: true });
    const fd = openSync(logPath(id), 'a');
    const proc = Bun.spawn([spec.python, ...spec.args], {
      cwd: spec.dir,
      stdout: fd,
      stderr: fd,
      stdin: 'ignore',
      env: { ...process.env },
    });
    procs[id] = { proc };
    proc.unref();
    void proc.exited.then((code) => {
      const wasStop = stopping.delete(id);
      if (procs[id]?.proc === proc) delete procs[id];
      // A nonzero exit we didn't ask for = a real failure (bad python, missing
      // deps, deleted install) — surface it so the toggle can explain.
      if (!wasStop && typeof code === 'number' && code !== 0) {
        lastError[id] = `${spec.label} exited (code ${code}). See ${logPath(id)}.`;
      }
    });
  } catch (e) {
    lastError[id] = `Could not launch ${spec.label}: ${e instanceof Error ? e.message : String(e)}`;
  }
  return getFooocusStatus();
}

/**
 * Stop a server. rubato only stops a process it started this session; an
 * externally-started instance is left running (with a note explaining why),
 * honoring "if it was already running, rubato ignores it".
 */
export async function stopFooocus(id: FooocusServerId): Promise<FooocusStatus> {
  const managed = procs[id];
  if (managed && !managed.proc.killed) {
    delete lastError[id];
    stopping.add(id);
    const { proc } = managed;
    try {
      proc.kill(); // SIGTERM
    } catch {
      // already gone
    }
    delete procs[id];
    // Escalate to SIGKILL if it ignores the polite request.
    const t = setTimeout(() => {
      try {
        if (!proc.killed) proc.kill(9);
      } catch {
        // gone
      }
    }, 4000);
    (t as { unref?: () => void }).unref?.();
    return getFooocusStatus();
  }

  // Not ours — but is something listening? Then it's external; don't touch it.
  const spec = (await resolveSpecs())[id];
  if (await probe(spec)) {
    lastError[id] = `${spec.label} was started outside rubato — stop it where you launched it.`;
  }
  return getFooocusStatus();
}

/**
 * Restart a server so newly-saved memory/VRAM launch flags take effect. Only a
 * process rubato manages can be cycled: an external instance is refused (same
 * policy as stop), and a stopped server is simply (re)started with the new args.
 * Waits for the old process to release its port before respawning, so the start's
 * own port-probe doesn't see the dying instance and skip the launch.
 */
export async function restartFooocus(id: FooocusServerId): Promise<FooocusStatus> {
  const spec = (await resolveSpecs())[id];
  const managed = isManaged(id);
  const up = await probe(spec);

  // Running but not ours → can't cycle it (we never started it).
  if (up && !managed) {
    lastError[id] = `${spec.label} was started outside rubato — restart it where you launched it.`;
    return getFooocusStatus();
  }

  if (managed) {
    await stopFooocus(id);
    // Wait (bounded) for the port to free up. stopFooocus SIGKILLs after 4s, so
    // ~6s is enough headroom; if it's still up, startFooocus will no-op and the
    // user can retry rather than us spawning a doomed duplicate.
    for (let i = 0; i < 12 && (await probe(spec, 500)); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return startFooocus(id);
}
