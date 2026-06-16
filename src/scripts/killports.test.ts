import { describe, expect, test } from 'bun:test';
import { parsePortRange } from './killports';

describe('parsePortRange', () => {
  test('single port → start == end', () => {
    expect(parsePortRange(['3000'])).toEqual({ start: 3000, end: 3000 });
  });

  test('a range', () => {
    expect(parsePortRange(['3000', '3005'])).toEqual({ start: 3000, end: 3005 });
  });

  test('ignores flags when parsing', () => {
    expect(parsePortRange(['3000', '--dry-run'])).toEqual({ start: 3000, end: 3000 });
  });

  test('errors: no args, invalid, out of range, reversed', () => {
    expect('error' in parsePortRange([])).toBe(true);
    expect('error' in parsePortRange(['abc'])).toBe(true);
    expect('error' in parsePortRange(['70000'])).toBe(true);
    expect('error' in parsePortRange(['3005', '3000'])).toBe(true);
  });
});
