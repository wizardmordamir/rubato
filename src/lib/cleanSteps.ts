/**
 * Tidy the steps lifted from a recorded capture so the generated automation
 * actually replays. A recorder faithfully logs everything the user did — which
 * includes noise that breaks a re-run:
 *
 *  - An empty `fill` (value ""), e.g. a password field re-focused after the
 *    post-login navigation, or a field the user cleared. It types nothing, and on
 *    replay the field it targeted is often gone (we navigated away), so it fails
 *    the whole run for no benefit. (This is exactly what stalled the captured
 *    cursedalchemy login replay.)
 *  - A `goto` to the same URL as the step right before it — a captured redirect
 *    chain records the landing page more than once.
 *
 * Cleanup happens at capture→automation time (not on every run) so the builder
 * shows a clean flow you can still hand-edit afterwards. Steps the user added by
 * hand in the builder go through `saveAutomation` and are NOT run through this.
 */

import type { Step } from '../shared/automation';

/** Does this `fill`/`select` step type a non-empty value? */
function fillsSomething(step: Step): boolean {
  return (step.params?.value ?? '').length > 0;
}

/** Drop no-op / duplicate steps a recording leaves behind (see file header). */
export function cleanCapturedSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const step of steps) {
    // An empty fill types nothing and usually targets an element a later
    // navigation removed — pure capture noise that fails replay.
    if (step.action === 'fill' && !fillsSomething(step)) continue;

    // Collapse a navigation that repeats the previous goto's URL.
    const prev = out[out.length - 1];
    if (step.action === 'goto' && prev?.action === 'goto' && (step.params?.url ?? '') === (prev.params?.url ?? '')) {
      continue;
    }

    out.push(step);
  }
  return out;
}
