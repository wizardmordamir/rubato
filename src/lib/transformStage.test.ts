import { describe, expect, test } from 'bun:test';
import type { TransformMapping } from '../shared/pipeline';
import { applyMappings, getByPath, pathTokens, valueToVar } from './transformStage';

describe('pathTokens', () => {
  test('splits dot and bracket notation', () => {
    expect(pathTokens('rows[2].name')).toEqual(['rows', '2', 'name']);
    expect(pathTokens('items.0.id')).toEqual(['items', '0', 'id']);
    expect(pathTokens('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  test('ignores empty/leading/trailing segments', () => {
    expect(pathTokens('.a..b.')).toEqual(['a', 'b']);
    expect(pathTokens('')).toEqual([]);
  });
});

describe('getByPath', () => {
  const data = {
    summary: { total: 42, label: 'ok' },
    items: [{ id: 'a' }, { id: 'b' }],
    rows: [{ name: 'zero' }, { name: 'one' }, { name: 'two' }],
    nested: { list: [10, 20, 30] },
  };

  test('returns the whole source for an empty path', () => {
    expect(getByPath(data, undefined)).toBe(data);
    expect(getByPath(data, '')).toBe(data);
  });

  test('walks object keys', () => {
    expect(getByPath(data, 'summary.total')).toBe(42);
    expect(getByPath(data, 'summary.label')).toBe('ok');
  });

  test('walks array indices via dot and bracket', () => {
    expect(getByPath(data, 'items.0.id')).toBe('a');
    expect(getByPath(data, 'items.1.id')).toBe('b');
    expect(getByPath(data, 'rows[2].name')).toBe('two');
    expect(getByPath(data, 'nested.list[1]')).toBe(20);
  });

  test('returns undefined for missing keys / out-of-range / wrong type', () => {
    expect(getByPath(data, 'summary.missing')).toBeUndefined();
    expect(getByPath(data, 'items.9.id')).toBeUndefined();
    expect(getByPath(data, 'summary.total.nope')).toBeUndefined(); // index into a number
    expect(getByPath(data, 'items.notANumber')).toBeUndefined(); // non-int array index
    expect(getByPath(null, 'a.b')).toBeUndefined();
  });
});

describe('valueToVar', () => {
  test('stringifies primitives as-is', () => {
    expect(valueToVar('hi')).toBe('hi');
    expect(valueToVar(42)).toBe('42');
    expect(valueToVar(0)).toBe('0');
    expect(valueToVar(false)).toBe('false');
  });

  test('JSON-stringifies objects and arrays', () => {
    expect(valueToVar({ a: 1 })).toBe('{"a":1}');
    expect(valueToVar([1, 'two'])).toBe('[1,"two"]');
  });

  test('undefined/null become undefined (so a default can apply)', () => {
    expect(valueToVar(undefined)).toBeUndefined();
    expect(valueToVar(null)).toBeUndefined();
  });
});

describe('applyMappings', () => {
  const source = {
    summary: { critical: 3, high: 7 },
    appName: 'billing-svc',
    findings: [{ sev: 'critical' }, { sev: 'high' }],
  };

  test('lifts dot-path fields into named vars (all string-valued)', () => {
    const mappings: TransformMapping[] = [
      { as: 'CRITICAL', path: 'summary.critical' },
      { as: 'HIGH', path: 'summary.high' },
      { as: 'APP', path: 'appName' },
    ];
    expect(applyMappings(source, mappings)).toEqual({
      CRITICAL: '3',
      HIGH: '7',
      APP: 'billing-svc',
    });
  });

  test('a path to an object/array is JSON-stringified', () => {
    expect(applyMappings(source, [{ as: 'FINDINGS', path: 'findings' }])).toEqual({
      FINDINGS: '[{"sev":"critical"},{"sev":"high"}]',
    });
  });

  test('an omitted path maps the whole source', () => {
    expect(applyMappings({ x: 1 }, [{ as: 'WHOLE' }])).toEqual({ WHOLE: '{"x":1}' });
  });

  test('missing path with a default uses the (interpolated) default', () => {
    const out = applyMappings(source, [{ as: 'MED', path: 'summary.medium', default: '0' }]);
    expect(out).toEqual({ MED: '0' });

    const interp = (s: string) => s.replace('${FALLBACK}', 'none');
    const out2 = applyMappings(source, [{ as: 'X', path: 'nope', default: '${FALLBACK}' }], interp);
    expect(out2).toEqual({ X: 'none' });
  });

  test('missing path with no default leaves the var unset', () => {
    expect(applyMappings(source, [{ as: 'GONE', path: 'not.here' }])).toEqual({});
  });

  test('skips mappings with no `as`', () => {
    expect(applyMappings(source, [{ as: '', path: 'appName' } as TransformMapping])).toEqual({});
  });
});
