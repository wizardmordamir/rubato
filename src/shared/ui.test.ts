import { expect, test } from 'bun:test';
import { defaultPageEnabled, resolvePages, UI_PAGES } from './ui';

// All pages default to enabled — users hide individual nav items via the sidebar
// kebab menu (stored in localStorage) rather than toggling a server-side config.
test('every non-merged page is enabled by default', () => {
  for (const p of UI_PAGES.filter((p) => !p.mergedInto)) {
    expect(defaultPageEnabled(p.key)).toBe(true);
  }
});

test('resolvePages enables all pages with no config and respects an explicit off', () => {
  expect(resolvePages(undefined)['env-compare']).toBe(true);
  expect(resolvePages({ pages: {} })['env-compare']).toBe(true);
  expect(resolvePages({ pages: { 'env-compare': false } })['env-compare']).toBe(false);
});

test('resolvePages propagates merged-page on to its parent', () => {
  // `services` is mergedInto `requests` — an explicit on for services enables requests.
  expect(resolvePages({ pages: { requests: false, services: true } }).requests).toBe(true);
});
