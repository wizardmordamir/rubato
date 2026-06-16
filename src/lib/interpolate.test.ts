import { afterEach, beforeEach, expect, test } from 'bun:test';
import { interpolate, redact } from './interpolate';

const KEY = 'RUBATO_TEST_SECRET';

beforeEach(() => {
  process.env[KEY] = 'hunter2';
});
afterEach(() => {
  delete process.env[KEY];
});

test('substitutes env vars and flags them redacted', () => {
  const r = interpolate(`pw=\${${KEY}}`, { scraped: {} });
  expect(r.value).toBe('pw=hunter2');
  expect(r.redacted).toBe(true);
});

test('substitutes scraped vars without redacting', () => {
  const r = interpolate('hi ${scraped.name}', { scraped: { name: 'world' } });
  expect(r.value).toBe('hi world');
  expect(r.redacted).toBe(false);
});

test('unknown vars become empty', () => {
  const r = interpolate('a${NOPE_NOT_SET}b', { scraped: {} });
  expect(r.value).toBe('ab');
  expect(r.redacted).toBe(false);
});

test('redact masks every occurrence', () => {
  expect(redact('login failed for hunter2 (hunter2)', 'hunter2')).toBe('login failed for *** (***)');
  expect(redact('x', '')).toBe('x');
});
