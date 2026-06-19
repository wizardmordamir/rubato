/**
 * Smart pacing for runs and playback. A full-speed automation flashes through its
 * steps so you can't see what each one did; this adds human-watchable pauses —
 * long after a click or navigation (so you can see the new screen), tiny after
 * typing, none after waits/assertions. One heuristic, shared by:
 *   - the interpreter's `beforeStep` gate (slow a live/headed run to watch it),
 *   - the timeline player's auto-advance (how long to show each moment),
 *   - the "Add smart waits" transform (bake `waitFor` steps into an automation).
 * Pure + dependency-free (browser- and server-safe).
 */

import type { ActionType, LeafAction, Step } from './automation';
import { uid } from 'cwip';

export type RunSpeed = 'off' | 'slow' | 'slower';

const SPEED_FACTOR: Record<RunSpeed, number> = { off: 0, slow: 1, slower: 2 };

/**
 * Base "let me see what just happened" pause (ms, at `slow`) keyed on the action
 * that just ran. Screen-changing actions get a real beat; typing barely any;
 * anything not listed (assertions, scrape, an explicit waitFor) gets none.
 */
const BASE_PAUSE: Partial<Record<ActionType, number>> = {
  goto: 1200,
  newTab: 1200,
  switchTab: 800,
  closeTab: 800,
  click: 700,
  check: 600,
  uncheck: 600,
  select: 600,
  setFiles: 600,
  press: 500,
  dialog: 500,
  hover: 300,
  fill: 150,
};

/** Pause (ms) to insert before the next step, given the action that just ran. */
export function smartWaitMs(prev: ActionType | undefined, speed: RunSpeed): number {
  const factor = SPEED_FACTOR[speed] ?? 0;
  if (!factor || !prev) return 0;
  return Math.round((BASE_PAUSE[prev] ?? 0) * factor);
}

/**
 * Actions worth capturing a screenshot/HTML frame after — the ones that change
 * what's on screen. Typing (`fill`), assertions, scrape, and waits don't get a
 * frame; `snapshot`/`screenshot` capture through their own path. Drives per-step
 * run capture (so a run builds a watchable timeline without a frame per keystroke).
 */
const MEANINGFUL: ReadonlySet<LeafAction> = new Set<LeafAction>([
  'goto',
  'newTab',
  'switchTab',
  'closeTab',
  'click',
  'check',
  'uncheck',
  'select',
  'setFiles',
  'press',
  'dialog',
]);

export function capturesFrame(action: LeafAction): boolean {
  return MEANINGFUL.has(action);
}

/**
 * Return a copy of `steps` with `waitFor` (ms) steps injected after screen-changing
 * steps so a replay is watchable. Recurses into `if` branches; never stacks a wait
 * next to an explicit one; tags inserted steps (note: "auto wait") so they're easy
 * to spot or remove. `off` ⇒ returns the input unchanged.
 */
/**
 * Only pauses at least this long get baked into the step list — so typing's tiny
 * settle (which run-time pacing still applies) doesn't litter the automation with
 * sub-second `waitFor` rows; only clicks/navigation earn a visible wait step.
 */
const MIN_BAKE_MS = 300;

export function insertSmartWaits(steps: Step[], speed: RunSpeed): Step[] {
  if (speed === 'off') return steps;
  const out: Step[] = [];
  let prev: ActionType | undefined;
  for (const step of steps) {
    const s: Step =
      step.action === 'if'
        ? {
            ...step,
            ...(step.thenSteps ? { thenSteps: insertSmartWaits(step.thenSteps, speed) } : {}),
            ...(step.elseSteps ? { elseSteps: insertSmartWaits(step.elseSteps, speed) } : {}),
          }
        : step;
    const ms = smartWaitMs(prev, speed);
    if (ms >= MIN_BAKE_MS && step.action !== 'waitFor' && prev !== 'waitFor') {
      out.push({ id: uid(), action: 'waitFor', params: { waitKind: 'ms', ms }, note: 'auto wait' });
    }
    out.push(s);
    prev = step.action;
  }
  return out;
}
