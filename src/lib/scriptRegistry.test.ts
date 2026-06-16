import { afterEach, expect, test } from 'bun:test';
import {
  clearRegisteredScripts,
  getRegisteredScript,
  listRegisteredScripts,
  registerScript,
  registerScripts,
} from './scriptRegistry';

afterEach(() => clearRegisteredScripts());

test('registers and retrieves a script', () => {
  registerScript({ id: 'noop', run: () => ({ status: 'passed' }) });
  expect(getRegisteredScript('noop')?.id).toBe('noop');
  expect(listRegisteredScripts()).toHaveLength(1);
});

test('later registration of the same id wins', () => {
  registerScript({ id: 'x', description: 'first', run: () => {} });
  registerScript({ id: 'x', description: 'second', run: () => {} });
  expect(getRegisteredScript('x')?.description).toBe('second');
  expect(listRegisteredScripts()).toHaveLength(1);
});

test('registerScripts adds several', () => {
  registerScripts([
    { id: 'a', run: () => {} },
    { id: 'b', run: () => {} },
  ]);
  expect(
    listRegisteredScripts()
      .map((s) => s.id)
      .sort(),
  ).toEqual(['a', 'b']);
});

test('rejects a missing run or invalid id', () => {
  expect(() => registerScript({ id: 'ok' } as never)).toThrow();
  expect(() => registerScript({ id: 'bad id', run: () => {} })).toThrow();
});
