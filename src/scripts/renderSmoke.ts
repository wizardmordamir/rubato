#!/usr/bin/env bun
/**
 * render-smoke  (installed as `rubato-render-smoke`)
 *
 * The per-task anti-WHITE-SCREEN check for UI-touching work: build the SPA (`web:build`,
 * cached), boot it on an isolated home + a free port, drive a HEADLESS browser at it, and
 * assert the React root actually MOUNTED with no fatal console / page errors. Run it BEFORE
 * marking a UI task done — `bun run tsc` + a green `bun run build` (which builds only the lib
 * dist, not the SPA) pass even when the app white-screens at runtime, which is exactly the
 * gap this closes. It builds the UI itself, so you don't need a prior `web:build`.
 *
 *   rubato-render-smoke [--port <n>] [--timeout <ms>] [--nav-timeout <ms>]
 *                       [--url <path>] [--root <selector>] [--cwd <dir>] [--strict]
 *
 * Exit codes: 0 = rendered cleanly (or INCONCLUSIVE — couldn't launch a browser; not a
 * failure unless `--strict`), 1 = ran and FAILED (white screen / fatal error). The same
 * core (`runRenderSmoke`) backs the promotion gate, so a worker's local check and the gate
 * agree on what "renders" means.
 */

import { consoleIo, type ScriptIo } from '../lib/scriptIo';
import {
  pickFreePort,
  type RenderSmokeResult,
  type RenderSmokeSpec,
  renderSmokeHomeDir,
  runRenderSmoke,
  rubatoRenderSmokeSpec,
} from '../server/taskq/renderSmoke';

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

/** The smoke runner is injectable so the CLI's arg-parsing + exit-code mapping is testable. */
export type SmokeRunner = (spec: RenderSmokeSpec) => Promise<RenderSmokeResult>;

export async function run(
  args: string[],
  io: ScriptIo = consoleIo,
  smoke: SmokeRunner = (spec) => runRenderSmoke(spec),
): Promise<number> {
  const strict = args.includes('--strict');
  const cwd = getOpt(args, 'cwd') ?? process.cwd();
  const portArg = getOpt(args, 'port');
  const timeoutArg = getOpt(args, 'timeout');
  const navTimeoutArg = getOpt(args, 'nav-timeout');
  const urlPath = getOpt(args, 'url');
  const rootSelector = getOpt(args, 'root');

  const port = portArg ? Number(portArg) : await pickFreePort();
  const spec = rubatoRenderSmokeSpec({
    cwd,
    port,
    homeDir: renderSmokeHomeDir('ru', `${process.pid}-${port}`),
    timeoutMs: timeoutArg ? Number(timeoutArg) : undefined,
    navTimeoutMs: navTimeoutArg ? Number(navTimeoutArg) : undefined,
  });
  if (urlPath) spec.urlPath = urlPath;
  if (rootSelector) spec.rootSelector = rootSelector;

  io.err(
    `render-smoke: ${spec.buildCmd ? `building (${spec.buildCmd.join(' ')}), ` : ''}booting ${spec.cmd.join(' ')} in ${cwd} on port ${port}, then loading ${spec.urlPath} …`,
  );
  const result = await smoke(spec);

  if (!result.ran) {
    // Inconclusive: no browser available / the server never booted. Don't block a worker's
    // landing on tooling absence (the promotion gate is the backstop) unless --strict.
    io.err(`render-smoke: INCONCLUSIVE — ${result.detail}`);
    io.err('render-smoke: (could not run a real browser here; the promotion gate render-smoke remains the backstop)');
    if (result.logTail) io.err(`server output tail:\n${result.logTail}`);
    return strict ? 2 : 0;
  }
  if (result.ok) {
    io.out(`✓ render-smoke GREEN — ${result.detail} (${result.durationMs}ms)`);
    return 0;
  }
  io.out(`✗ render-smoke RED — ${result.detail} (${result.durationMs}ms)`);
  if (result.probe?.pageErrors?.length) io.err(`page errors:\n${result.probe.pageErrors.join('\n')}`);
  if (result.probe?.consoleErrors?.length) io.err(`console errors:\n${result.probe.consoleErrors.join('\n')}`);
  if (result.logTail) io.err(`server output tail:\n${result.logTail}`);
  return 1;
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
