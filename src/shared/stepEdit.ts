/**
 * Pure, dependency-free helpers for editing an automation's step list — id
 * generation, deep step cloning, and array reordering. Browser- and server-safe
 * (no React, no DOM, no Node), so the builder UI, the smart-wait transform, and
 * tests can all share one implementation.
 */

import type { Step, Target } from './automation';

/** A stable id for a step (or any keyed row). Prefers crypto.randomUUID. */
export function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Math.random().toString(36).slice(2, 10)}`;
}

/** Deep-clone a Target, including a nested container scope. */
function cloneTarget(t: Target): Target {
  return { ...t, ...(t.container ? { container: cloneTarget(t.container) } : {}) };
}

/**
 * Deep-clone a step with fresh ids throughout (the step itself and, recursively,
 * an `if`'s then/else branches), so a cloned step never shares an id with its
 * source — ids key React rows and per-step run results. Nested objects (params,
 * options, target, condition) are copied so edits to the clone don't mutate the
 * original.
 */
export function cloneStep(step: Step): Step {
  const copy: Step = { ...step, id: uid() };
  if (step.params) copy.params = { ...step.params };
  if (step.options) copy.options = { ...step.options };
  if (step.target) copy.target = cloneTarget(step.target);
  if (step.condition) {
    copy.condition = { ...step.condition };
    if (step.condition.target) copy.condition.target = cloneTarget(step.condition.target);
  }
  if (step.thenSteps) copy.thenSteps = step.thenSteps.map(cloneStep);
  if (step.elseSteps) copy.elseSteps = step.elseSteps.map(cloneStep);
  return copy;
}

/**
 * Move the item at `from` to a boundary index `boundary` (0..length, the gaps
 * between/around items), returning a new array. Boundaries that resolve to the
 * item's current position (`from` or `from + 1`) are no-ops. Used by drag-reorder
 * where drop targets sit between rows.
 */
export function reorderSteps<T>(arr: T[], from: number, boundary: number): T[] {
  if (from < 0 || from >= arr.length || boundary === from || boundary === from + 1) return arr;
  const without = arr.filter((_, i) => i !== from);
  const at = boundary > from ? boundary - 1 : boundary;
  without.splice(Math.max(0, Math.min(at, without.length)), 0, arr[from]);
  return without;
}
