/**
 * In-process custom-script registry — the programmatic half of "custom functions".
 *
 * An app that embeds rubato (`import { on } from "rubato/server"`) keeps its own scripts
 * in its own codebase and registers them at startup, so they run *in-process* with
 * full access to that app's libraries (xlsx, db clients, …):
 *
 *   import { registerScript } from "rubato";  // + import { on } from "rubato/server"
 *   registerScript({
 *     id: "xlsx-to-csv",
 *     description: "Flatten the downloaded workbook to CSV",
 *     async run({ dir, vars, params, log }) {
 *       const file = `${dir}/report.xlsx`;
 *       log(`reading ${file}`);
 *       // …transform, write `${dir}/result.csv`…
 *       return { status: "passed", vars: { rows: String(count) } };
 *     },
 *   });
 *   on();
 *
 * Pure: a module-level Map of id → definition, no server/db/Bun coupling, so it
 * imports cleanly into the library barrel. The run functions are user closures;
 * the registry never invokes them — the server's executor does.
 */

import type { ScriptParam, StageOutcome } from '../shared/pipeline';

/** What a registered script's `run` receives. The shared run dir + vars bag. */
export interface ScriptRunContext {
  /** The per-run working directory (also RUBATO_RUN_DIR for file scripts). */
  dir: string;
  /**
   * The output dir, ~/.rubato/outputs (also RUBATO_OUTPUT_DIR for file scripts).
   * Write a final report here to make it downloadable/viewable in the web UI Files tab.
   */
  outputDir: string;
  /** The vars bag — env-like values from the preload form / prior stages. */
  vars: Record<string, string>;
  /** The values supplied for this script's declared params. */
  params: Record<string, string | number | boolean>;
  /** Append a line to the run log (streamed to the UI + captured). */
  log: (message: string) => void;
}

export interface RegisteredScript {
  /** Stable id, referenced by pipelines and the run API. */
  id: string;
  /** Display name (defaults to the id). */
  name?: string;
  description?: string;
  /** Declared inputs — drive the run form; passed through as `ctx.params`. */
  params?: ScriptParam[];
  /** Do the work. Return a StageOutcome, or nothing for a plain pass. */
  run(ctx: ScriptRunContext): Promise<StageOutcome | undefined> | StageOutcome | undefined;
}

const registry = new Map<string, RegisteredScript>();

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/** Register one in-process script. Later registrations of the same id win. */
export function registerScript(def: RegisteredScript): void {
  if (!def || typeof def.run !== 'function') throw new Error('registerScript: a `run` function is required');
  if (!ID_RE.test(def.id ?? '')) throw new Error(`registerScript: invalid id ${JSON.stringify(def.id)}`);
  registry.set(def.id, def);
}

/** Register several at once (e.g. from `on({ scripts })`). */
export function registerScripts(defs: readonly RegisteredScript[] = []): void {
  for (const d of defs) registerScript(d);
}

export function getRegisteredScript(id: string): RegisteredScript | undefined {
  return registry.get(id);
}

export function listRegisteredScripts(): RegisteredScript[] {
  return [...registry.values()];
}

/** Drop all registrations (tests). */
export function clearRegisteredScripts(): void {
  registry.clear();
}
