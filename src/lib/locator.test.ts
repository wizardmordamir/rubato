import { expect, test } from 'bun:test';
import { targetToSelectorString } from './locator';

test('renders each target kind', () => {
  expect(targetToSelectorString({ kind: 'testid', value: 'submit' })).toBe('testid=submit');
  expect(targetToSelectorString({ kind: 'id', value: 'email' })).toBe('#email');
  expect(targetToSelectorString({ kind: 'class', value: 'btn' })).toBe('.btn');
  expect(targetToSelectorString({ kind: 'css', value: 'div > a' })).toBe('div > a');
  expect(targetToSelectorString({ kind: 'href', value: '/home' })).toBe('a[href="/home"]');
});

test('role with name and exact', () => {
  expect(targetToSelectorString({ kind: 'role', value: 'button', name: 'Save', exact: true })).toBe(
    'role=button[name="Save" exact]',
  );
  expect(targetToSelectorString({ kind: 'role', value: 'button' })).toBe('role=button');
});

test('nth and container scoping', () => {
  expect(targetToSelectorString({ kind: 'css', value: 'li', nth: 2 })).toBe('li[2]');
  expect(
    targetToSelectorString({
      kind: 'role',
      value: 'button',
      name: 'Save',
      container: { kind: 'testid', value: 'modal' },
    }),
  ).toBe('testid=modal » role=button[name="Save"]');
});
