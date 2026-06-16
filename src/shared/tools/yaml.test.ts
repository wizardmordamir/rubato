import { describe, expect, test } from 'bun:test';
import { formatYaml } from './yaml';

describe('formatYaml', () => {
  test('normalizes valid YAML with the given indent', () => {
    const result = formatYaml('foo:    bar\nbaz:  1', { indent: 2, sortKeys: false, toJson: false });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('foo: bar\nbaz: 1');
  });

  test('respects a 4-space indent for nested maps', () => {
    const result = formatYaml('a:\n  b:\n    c: 1', { indent: 4, sortKeys: false, toJson: false });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('a:\n    b:\n        c: 1');
  });

  test('sorts map keys when sortKeys is set', () => {
    const result = formatYaml('b: 2\na: 1\nc: 3', { indent: 2, sortKeys: true, toJson: false });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('a: 1\nb: 2\nc: 3');
  });

  test('leaves key order untouched when sortKeys is off', () => {
    const result = formatYaml('b: 2\na: 1', { indent: 2, sortKeys: false, toJson: false });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('b: 2\na: 1');
  });

  test('converts YAML to JSON when toJson is set', () => {
    const result = formatYaml('foo: bar\nnums:\n  - 1\n  - 2', { indent: 2, sortKeys: false, toJson: true });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ foo: 'bar', nums: [1, 2] });
    expect(result.output).toBe('{\n  "foo": "bar",\n  "nums": [\n    1,\n    2\n  ]\n}');
  });

  test('returns an empty ok result for blank input', () => {
    const result = formatYaml('   \n  ', { indent: 2, sortKeys: false, toJson: false });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('');
  });

  test('reports not-ok with a message and position on invalid YAML', () => {
    const result = formatYaml('foo: [1, 2\nbar: baz', { indent: 2, sortKeys: false, toJson: false });
    expect(result.ok).toBe(false);
    expect(result.output).toBe('');
    expect(result.error).toBeTruthy();
    expect(typeof result.error).toBe('string');
    expect(result.errorLine).toBeGreaterThan(0);
  });
});
