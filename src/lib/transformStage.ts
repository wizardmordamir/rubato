/**
 * Pure logic for the `transform` pipeline stage — the cross-step data-mapping
 * layer. Given an already-resolved source value (a parsed JSON object/array a
 * prior stage produced, or the vars bag) and a list of mappings, it lifts
 * dot/bracket JSON-path fields into a flat `Record<string, string>` of vars for
 * later stages. The impure bits — reading the source from a file/var/inline and
 * interpolating ${VAR}/${run.dir} — live in the server executor
 * (src/server/stageExecutors.ts); this module stays Node-free and unit-testable.
 */

import type { TransformMapping } from '../shared/pipeline';

/**
 * Split a dot/bracket path into tokens: `rows[2].name` → ["rows", "2", "name"],
 * `items.0.id` → ["items", "0", "id"]. Leading/trailing dots are ignored.
 */
export function pathTokens(path: string): string[] {
  const out: string[] = [];
  for (const raw of path.replace(/\[(\w+)\]/g, '.$1').split('.')) {
    const tok = raw.trim();
    if (tok) out.push(tok);
  }
  return out;
}

/**
 * Walk a dot/bracket path into a parsed value. Returns undefined if any segment
 * is missing or the value isn't indexable there (so a `default` can apply). An
 * empty path returns the source unchanged.
 */
export function getByPath(source: unknown, path: string | undefined): unknown {
  if (!path) return source;
  let cur: unknown = source;
  for (const tok of pathTokens(path)) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(tok);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[tok];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Stringify a resolved value for the vars bag (always string-valued): primitives
 * pass through via String(); objects/arrays are JSON-stringified so a whole
 * subtree can ride a var to the next stage. undefined/null → undefined (the
 * caller then applies a default or leaves the var unset).
 */
export function valueToVar(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Apply mappings against a resolved source, producing the vars to merge forward.
 * `interp` interpolates a mapping's `default` (so it can reference ${VAR} etc.).
 * A mapping whose path is missing AND has no default is skipped (var left unset).
 */
export function applyMappings(
  source: unknown,
  mappings: TransformMapping[],
  interp: (s: string) => string = (s) => s,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const m of mappings) {
    if (!m?.as) continue;
    const resolved = valueToVar(getByPath(source, m.path));
    if (resolved !== undefined) {
      vars[m.as] = resolved;
    } else if (m.default !== undefined) {
      vars[m.as] = interp(m.default);
    }
  }
  return vars;
}
