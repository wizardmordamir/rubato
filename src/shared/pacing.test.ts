import { expect, test } from 'bun:test';
import type { Step } from './automation';
import { capturesFrame, insertSmartWaits, smartWaitMs } from './pacing';

test('smartWaitMs pauses after screen-changing actions, not typing, and scales with speed', () => {
  expect(smartWaitMs('click', 'off')).toBe(0);
  expect(smartWaitMs(undefined, 'slow')).toBe(0); // first step: nothing ran yet
  expect(smartWaitMs('click', 'slow')).toBeGreaterThan(smartWaitMs('fill', 'slow'));
  expect(smartWaitMs('goto', 'slow')).toBeGreaterThanOrEqual(smartWaitMs('click', 'slow'));
  expect(smartWaitMs('click', 'slower')).toBe(2 * smartWaitMs('click', 'slow'));
  expect(smartWaitMs('expectText', 'slow')).toBe(0); // assertions don't pace
});

test('capturesFrame is true for screen-changing steps, false for typing/asserts', () => {
  expect(capturesFrame('click')).toBe(true);
  expect(capturesFrame('goto')).toBe(true);
  expect(capturesFrame('fill')).toBe(false);
  expect(capturesFrame('expectText')).toBe(false);
  expect(capturesFrame('snapshot')).toBe(false); // captured via its own path
});

test('insertSmartWaits injects a wait after a click (before the next step), not after typing', () => {
  const steps: Step[] = [
    { id: 'a', action: 'fill', target: { kind: 'id', value: 'q' }, params: { value: 'hi' } },
    { id: 'b', action: 'click', target: { kind: 'role', value: 'button' } },
    { id: 'c', action: 'fill', target: { kind: 'id', value: 'q2' }, params: { value: 'yo' } },
  ];
  const out = insertSmartWaits(steps, 'slow');
  // a wait lands between the click and the following fill (so you see the click's result),
  // but not between the first fill and the click (typing needs no pause)
  expect(out.map((s) => s.action)).toEqual(['fill', 'click', 'waitFor', 'fill']);
  const wait = out[2];
  expect(wait.params?.waitKind).toBe('ms');
  expect(wait.params?.ms).toBeGreaterThan(0);
});

test('insertSmartWaits recurses into if branches and never stacks on an explicit wait', () => {
  const steps: Step[] = [
    {
      id: 'if',
      action: 'if',
      thenSteps: [
        { id: 't1', action: 'click', target: { kind: 'id', value: 'x' } },
        { id: 't2', action: 'waitFor', params: { waitKind: 'ms', ms: 50 } },
        { id: 't3', action: 'click', target: { kind: 'id', value: 'y' } },
      ],
      elseSteps: [],
    },
  ];
  const out = insertSmartWaits(steps, 'slow');
  const then = out[0].thenSteps!.map((s) => s.action);
  // click → (existing waitFor, not doubled) → click; only the trailing click gets none after it
  expect(then).toEqual(['click', 'waitFor', 'click']);
});

test('insertSmartWaits at speed off is a no-op (same reference)', () => {
  const steps: Step[] = [{ id: 'a', action: 'click' }];
  expect(insertSmartWaits(steps, 'off')).toBe(steps);
});
