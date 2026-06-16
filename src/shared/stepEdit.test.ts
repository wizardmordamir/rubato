import { expect, test } from 'bun:test';
import type { Step } from './automation';
import { cloneStep, reorderSteps } from './stepEdit';

const step = (id: string, extra: Partial<Step> = {}): Step => ({ id, action: 'click', ...extra });

test('cloneStep gives the step a fresh id and re-ids nested if branches', () => {
  const src: Step = {
    id: 'root',
    action: 'if',
    condition: { kind: 'selector-visible', target: { kind: 'testid', value: 'x' } },
    thenSteps: [step('t1'), step('t2')],
    elseSteps: [{ id: 'e1', action: 'if', thenSteps: [step('e1a')], elseSteps: [] }],
  };
  const copy = cloneStep(src);

  expect(copy.id).not.toBe('root');
  expect(copy.thenSteps?.map((s) => s.id)).not.toEqual(['t1', 't2']);
  expect(copy.elseSteps?.[0].id).not.toBe('e1');
  expect(copy.elseSteps?.[0].thenSteps?.[0].id).not.toBe('e1a');
  // every id in the clone is unique
  const ids: string[] = [];
  const walk = (s: Step) => {
    ids.push(s.id);
    s.thenSteps?.forEach(walk);
    s.elseSteps?.forEach(walk);
  };
  walk(copy);
  expect(new Set(ids).size).toBe(ids.length);
});

test('cloneStep deep-copies params/target so edits do not bleed into the source', () => {
  const src = step('a', { params: { value: 'hi' }, target: { kind: 'id', value: 'btn' } });
  const copy = cloneStep(src);
  copy.params!.value = 'changed';
  copy.target!.value = 'other';
  expect(src.params?.value).toBe('hi');
  expect(src.target?.value).toBe('btn');
});

test('reorderSteps moves an item to a boundary (drop before that index)', () => {
  const a = ['a', 'b', 'c', 'd'];
  // move "a" (0) to boundary 2 → between b and c
  expect(reorderSteps(a, 0, 2)).toEqual(['b', 'a', 'c', 'd']);
  // move "d" (3) to boundary 1 → between a and b
  expect(reorderSteps(a, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  // move "b" (1) to the end (boundary 4)
  expect(reorderSteps(a, 1, 4)).toEqual(['a', 'c', 'd', 'b']);
});

test('reorderSteps is a no-op when the boundary is the item itself', () => {
  const a = ['a', 'b', 'c'];
  expect(reorderSteps(a, 1, 1)).toBe(a); // boundary === from
  expect(reorderSteps(a, 1, 2)).toBe(a); // boundary === from + 1 (same slot)
});
