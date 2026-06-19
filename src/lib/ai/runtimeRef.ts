/**
 * A compact `[Runtime Reference]` block injected into the system prompt for
 * code-shaped questions, so the model grounds on the *real* runtime + project
 * instead of guessing: the Bun version, the app's absolute path (the canonical
 * cwd for any file path it writes), the key dependencies (so it imports things
 * that actually exist at versions that actually exist), and — for CLI tools named
 * in the question — a real `--version` slice (so it anchors on installed tool
 * versions, not hallucinated flags/output shapes).
 *
 * Everything here is best-effort: any probe that fails is simply omitted. The
 * block is memoized per (app, question) for a short TTL so re-asks are free.
 */

import type { AppConfig } from '../apps';
import { readPackageJson } from '../apps';

/**
 * CLI tools we'll probe for a version. An allowlist (not "any token in the
 * question") keeps this from spawning arbitrary commands — only these names, and
 * only when they're both mentioned and present on PATH, are ever executed.
 */
const PROBE_ALLOWLIST = new Set([
  'bun',
  'node',
  'git',
  'tsc',
  'biome',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  'esbuild',
  'prisma',
  'tsx',
  'deno',
  'npm',
  'pnpm',
  'yarn',
  'docker',
]);

/** Cap the dependency list so the block stays small (~300 tokens). */
const MAX_DEPS = 40;
/** Probe timeout — a `--version` call should be near-instant; don't hang the ask. */
const PROBE_TIMEOUT_MS = 1500;
/** Memoize for this long so repeated questions about an app don't re-probe. */
const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { ts: number; block: string }>();

/** Pull the tool names the question mentions that we're allowed to probe. */
function probeCandidates(question: string): string[] {
  const tokens = new Set(question.toLowerCase().match(/[a-z][a-z0-9-]*/g) ?? []);
  return [...tokens].filter((t) => PROBE_ALLOWLIST.has(t));
}

/**
 * Run `<cmd> --version` with a hard timeout and return a one-line slice, or null.
 * Allowlist-gated by the caller; the binary is resolved with Bun.which first so we
 * never shell out to something that isn't installed.
 */
async function probeVersion(cmd: string): Promise<string | null> {
  const bin = Bun.which(cmd);
  if (!bin) return null;
  try {
    const proc = Bun.spawn([bin, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      // Some tools (e.g. tsc) print the version to stdout but exit non-zero on
      // bare invocation in odd setups; the timeout kills anything that hangs.
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const text = (out.trim() || err.trim()).split('\n')[0]?.trim() ?? '';
    if (!text) return null;
    // Keep a short slice; some tools emit a verbose first line.
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  } catch {
    return null; // not installed / timed out / not probe-friendly — just skip it
  }
}

/** Format `dependencies` + `devDependencies` as `name@version` lines, capped. */
function formatDeps(pkg: Record<string, unknown> | undefined): string[] {
  if (!pkg) return [];
  const out: string[] = [];
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
      if (out.length >= MAX_DEPS) break;
      out.push(`${name}@${typeof version === 'string' ? version : '*'}`);
    }
  }
  return out;
}

/**
 * Build the `[Runtime Reference]` markdown block for an app + question. Returns ''
 * when there's nothing useful to say (it then injects nothing).
 */
export async function buildRuntimeRef(app: AppConfig, question: string): Promise<string> {
  const key = `${app.name}::${question.trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.block;

  const lines: string[] = [];
  lines.push(`Runtime: Bun ${Bun.version}`);
  lines.push(`App root (use for absolute file paths): ${app.absolutePath}`);

  const pkg = await readPackageJson(app.absolutePath).catch(() => undefined);
  const deps = formatDeps(pkg);
  if (deps.length) {
    lines.push(`Key dependencies (do not import packages absent from this list): ${deps.join(', ')}`);
  }

  const candidates = probeCandidates(question);
  if (candidates.length) {
    const probed = await Promise.all(
      candidates.map(async (c) => {
        const v = await probeVersion(c);
        return v ? `${c}: ${v}` : null;
      }),
    );
    const found = probed.filter((p): p is string => p !== null);
    if (found.length) {
      lines.push(`Installed tools (probed --version): ${found.join(' · ')}`);
    }
  }

  const block = `[Runtime Reference]\n${lines.join('\n')}`;
  cache.set(key, { ts: Date.now(), block });
  return block;
}

/** Test seam: clear the memo (so a unit test can re-probe deterministically). */
export function _clearRuntimeRefCache(): void {
  cache.clear();
}
