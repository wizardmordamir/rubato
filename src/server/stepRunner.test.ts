/**
 * The live step-through executor must not hang when the user closes the headed
 * browser out from under a run. Before the browser-closed wiring, a run PAUSED in
 * step mode (blocked in the gate, not on a host command) never noticed the window
 * closing, so `automation:run:completed` never fired and the UI sat on "Running…"
 * forever. These drive a fake host (startStep's factory seam) so the lifecycle is
 * testable without spawning a real Chromium.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ActionOutcome, Automation } from '../shared/automation';
import type { ServerEvent } from '../shared/types';
import { subscribe } from './events';
import { type StepHost, startStep, stepPlay, stepStatus, stopStep } from './stepRunner';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A BrowserHost stand-in: every command is a no-op so the run's only blocking
 *  point is the step gate. Calling `onExit` simulates the host process dying — the
 *  same callback a real closed window triggers. */
class FakeHost implements StepHost {
  onExit: ((code: number | null) => void) | null = null;
  async start(): Promise<void> {}
  async launch(): Promise<unknown> {
    return {};
  }
  async close(): Promise<void> {}
  kill(): void {}
  async exec(): Promise<ActionOutcome> {
    return {};
  }
  async condition(): Promise<boolean> {
    return false;
  }
}

function makeAutomation(): Automation {
  const now = 1_700_000_000_000;
  return {
    id: 'stepRunner-close-test',
    name: 'close-mid-run',
    // A single page-level wait — needs no target, so the fake host's exec suffices.
    steps: [{ id: 's0', action: 'waitFor', params: { waitKind: 'load' } }],
    createdAt: now,
    updatedAt: now,
  };
}

const completedOf = (events: ServerEvent[]) =>
  events.find(
    (e): e is Extract<ServerEvent, { type: 'automation:run:completed' }> => e.type === 'automation:run:completed',
  );

describe('stepRunner — browser-closed detection', () => {
  afterEach(async () => {
    await stopStep();
  });

  test('closing the browser while PAUSED completes the run instead of hanging on "Running…"', async () => {
    const events: ServerEvent[] = [];
    const unsub = subscribe((e) => events.push(e));
    const fake = new FakeHost();
    try {
      await startStep(makeAutomation(), 'slow', () => fake);
      // Let the interpreter reach the first step's gate and pause there (step mode).
      await sleep(20);
      expect(stepStatus().active).toBe(true);
      // The run is paused, NOT completed — this is the state the bug got stuck in.
      expect(completedOf(events)).toBeUndefined();

      // The user closes the headed window out from under the paused run.
      fake.onExit?.(75);
      await sleep(20);

      // It must now complete (so the UI clears "Running…"), recorded as a failure
      // since the run never actually finished, and the session is no longer active.
      const completed = completedOf(events);
      expect(completed).toBeDefined();
      expect(completed?.run.status).toBe('failed');
      expect(completed?.heldOpen).toBe(false);
      expect(stepStatus().active).toBe(false);
    } finally {
      unsub();
    }
  });

  test('closing the HELD browser after a finished run clears the kept-open banner', async () => {
    const events: ServerEvent[] = [];
    const unsub = subscribe((e) => events.push(e));
    const fake = new FakeHost();
    try {
      await startStep(makeAutomation(), 'slow', () => fake);
      await sleep(20);
      // Play through the single step → the run finishes and holds the window open.
      stepPlay();
      await sleep(20);
      const completed = completedOf(events);
      expect(completed).toBeDefined();
      expect(completed?.run.status).toBe('passed');
      expect(completed?.heldOpen).toBe(true);

      // Now the user closes that held window — drop the "kept open" banner.
      fake.onExit?.(75);
      await sleep(20);
      expect(events.some((e) => e.type === 'automation:browser:closed')).toBe(true);
      expect(stepStatus().active).toBe(false);
    } finally {
      unsub();
    }
  });
});
