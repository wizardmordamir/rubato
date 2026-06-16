/**
 * Discover custom `*.ts` scripts from ~/.rubato/scripts — the file half of "custom
 * functions", mirroring the userTools idiom. Each script is a runnable stage.
 * Metadata (description, params, timeout) comes from an optional sidecar
 * `name.meta.json`, so listing never has to execute arbitrary user code.
 *
 * The script contract (run by src/server/scripts.ts):
 *   - spawned with Bun, cwd = the per-run dir, with RUBATO_RUN_DIR / RUBATO_VARS /
 *     RUBATO_PARAMS + each var injected as an env var;
 *   - may write `$RUBATO_RUN_DIR/outputs.json` = { vars?: Record<string,string> }
 *     to hand values to later stages; a pure file-in/file-out script emits nothing.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { ScriptParam, ScriptParamType } from '../shared/pipeline';
import { slugify } from './automations';
import { SCRIPTS_DIR } from './config';

export interface UserScript {
  /** Slug of the filename (the addressable id). */
  id: string;
  /** Absolute path to the `.ts` file. */
  file: string;
  name: string;
  description?: string;
  params?: ScriptParam[];
  /** Per-script timeout in ms (sidecar override of the global default). */
  timeout?: number;
}

interface ScriptMeta {
  description?: string;
  params?: ScriptParam[];
  timeout?: number;
}

/** Where discoverable scripts live — always ~/.rubato/scripts (see SCRIPTS_DIR). */
export function resolveScriptsDir(): string {
  return SCRIPTS_DIR;
}

const PARAM_TYPES: ScriptParamType[] = ['string', 'number', 'boolean'];

/** Coerce a sidecar's loose JSON into validated params (drops malformed ones). */
function parseParams(raw: unknown): ScriptParam[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const params: ScriptParam[] = [];
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) continue;
    const o = p as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name) continue;
    const type = PARAM_TYPES.includes(o.type as ScriptParamType) ? (o.type as ScriptParamType) : 'string';
    const param: ScriptParam = {
      name: o.name,
      type,
      description: typeof o.description === 'string' ? o.description : undefined,
      required: o.required === true,
    };
    // Only carry a default when the sidecar declares a scalar one (keeps the
    // shape clean for params that don't set it).
    if (typeof o.default === 'string' || typeof o.default === 'number' || typeof o.default === 'boolean') {
      param.default = o.default;
    }
    params.push(param);
  }
  return params.length ? params : undefined;
}

async function readMeta(dir: string, base: string): Promise<ScriptMeta> {
  try {
    const raw = JSON.parse(await readFile(resolve(dir, `${base}.meta.json`), 'utf8')) as Record<string, unknown>;
    return {
      description: typeof raw.description === 'string' ? raw.description : undefined,
      params: parseParams(raw.params),
      timeout: typeof raw.timeout === 'number' ? raw.timeout : undefined,
    };
  } catch {
    return {}; // no sidecar → name from filename, no params
  }
}

/** Whether a filename is a discoverable script (skip sidecars/tests/throwaways). */
function isScriptFile(name: string): boolean {
  if (!name.endsWith('.ts')) return false;
  if (name.endsWith('.meta.json') || name.endsWith('.test.ts') || name.includes('.ignore.')) return false;
  if (name.startsWith('___') || name.startsWith('.')) return false;
  return true;
}

/** All discoverable scripts in the dir, most-recently-named first is not promised. */
export async function loadUserScripts(dir = resolveScriptsDir()): Promise<UserScript[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter(isScriptFile).sort();
  } catch {
    return []; // no scripts dir → none
  }
  const scripts: UserScript[] = [];
  for (const name of names) {
    const base = basename(name, '.ts');
    const meta = await readMeta(dir, base);
    scripts.push({
      id: slugify(base),
      file: resolve(dir, name),
      name: base,
      description: meta.description,
      params: meta.params,
      timeout: meta.timeout,
    });
  }
  return scripts;
}

export async function getUserScript(id: string, dir = resolveScriptsDir()): Promise<UserScript | null> {
  return (await loadUserScripts(dir)).find((s) => s.id === id) ?? null;
}
