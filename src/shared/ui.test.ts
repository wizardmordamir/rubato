import { expect, test } from 'bun:test';
import { defaultPageEnabled, resolvePages, UI_PAGES } from './ui';

// The whole Docs hub ships on by default (it replaced the always-available
// CLAUDE.md/config footer icons), and the env-compare tool is part of that hub.
// A stray "the page is built but invisible because its default is off" bug is
// exactly how the Env Files page went unfindable, so pin the default-on set.
const EXPECTED_DEFAULT_ON = ['apps', 'excel', 'docs', 'system-files', 'env-compare', 'config', 'customPages'];

test('defaultPageEnabled has the Docs hub (incl. env-compare) on out of the box', () => {
  for (const key of EXPECTED_DEFAULT_ON) {
    expect(defaultPageEnabled(key)).toBe(true);
  }
});

test('every default-on page is a real, non-merged registry page', () => {
  for (const key of EXPECTED_DEFAULT_ON) {
    const page = UI_PAGES.find((p) => p.key === key);
    expect(page, `default-on key "${key}" must exist in UI_PAGES`).toBeDefined();
    expect(page?.mergedInto, `default-on key "${key}" must not be a merged page`).toBeUndefined();
  }
});

test('non-Docs/non-core pages stay opt-in by default', () => {
  // A sampling of opt-in pages — these should not light up without an explicit toggle.
  for (const key of ['queries', 'vulnerabilities', 'board', 'dashboard', 'ask']) {
    expect(defaultPageEnabled(key)).toBe(false);
  }
});

test('resolvePages turns env-compare on with no config and respects an explicit off', () => {
  expect(resolvePages(undefined)['env-compare']).toBe(true);
  expect(resolvePages({ pages: {} })['env-compare']).toBe(true);
  expect(resolvePages({ pages: { 'env-compare': false } })['env-compare']).toBe(false);
});
