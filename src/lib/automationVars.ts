/**
 * Scan an automation for the variables it needs supplied at run time — so the UI
 * can build a preload form and the server can validate a run request before it
 * starts. Pure and side-effect free (no env lookups here): it only reports *which*
 * variables are referenced, not whether they're set.
 *
 * Two kinds of reference are collected:
 *   - "interpolation" — a `${VAR}` placeholder in a step's value / url / path (or
 *     the automation's startUrl). `${scraped.x}` and `${run.dir}` are runtime
 *     channels, not preload vars, so they're excluded.
 *   - "env-mode" — a `valueMode:"env"` step whose `value` IS an env-var name.
 */

import type { Automation, Step } from '../shared/automation';

export type VarSource = 'interpolation' | 'env-mode';

export interface RequiredVar {
  name: string;
  /** Why it's needed (a var can be referenced both ways across steps). */
  sources: VarSource[];
}

// Same shape as the interpolate regex so the two never drift.
const VAR = /\$\{([^}]+)\}/g;

function record(map: Map<string, Set<VarSource>>, name: string, source: VarSource): void {
  const set = map.get(name) ?? new Set<VarSource>();
  set.add(source);
  map.set(name, set);
}

/** Bare `${VAR}` env names in a string (skips scraped./run./dotted runtime keys). */
export function extractVarNames(text: string | undefined): string[] {
  if (!text?.includes('${')) return [];
  const out: string[] = [];
  for (const m of text.matchAll(VAR)) {
    const key = m[1].trim();
    // Dotted keys are runtime channels (scraped.x, run.dir) or not env names.
    if (key && !key.includes('.')) out.push(key);
  }
  return out;
}

function collectInterpolated(map: Map<string, Set<VarSource>>, text: string | undefined): void {
  for (const key of extractVarNames(text)) record(map, key, 'interpolation');
}

function walk(steps: Step[], map: Map<string, Set<VarSource>>, depth: number): void {
  if (depth > 25) return;
  for (const step of steps) {
    const p = step.params;
    if (p) {
      if (p.valueMode === 'env') {
        const name = typeof p.value === 'string' ? p.value.trim() : '';
        if (name) record(map, name, 'env-mode');
      } else {
        collectInterpolated(map, p.value);
      }
      collectInterpolated(map, p.url);
      collectInterpolated(map, p.path);
    }
    if (step.thenSteps?.length) walk(step.thenSteps, map, depth + 1);
    if (step.elseSteps?.length) walk(step.elseSteps, map, depth + 1);
  }
}

/** The unique, name-sorted set of variables an automation references. */
export function collectAutomationVars(automation: Automation): RequiredVar[] {
  const map = new Map<string, Set<VarSource>>();
  collectInterpolated(map, automation.startUrl);
  walk(automation.steps ?? [], map, 0);
  return [...map.entries()]
    .map(([name, sources]) => ({ name, sources: [...sources].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
