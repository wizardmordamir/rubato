import { describe, expect, it } from 'bun:test';
import { explainRegex, REGEX_BLOCKS, REGEX_FLAGS, REGEX_RECIPES, testRegex } from './regex';

describe('explainRegex', () => {
  it('explains \\d{3}-\\d{4} as escapes, quantifiers, and a literal', () => {
    const { ok, nodes } = explainRegex('\\d{3}-\\d{4}');
    expect(ok).toBe(true);
    // \d{3}  '-'  \d{4}  → three top-level rows.
    expect(nodes).toHaveLength(3);
    expect(nodes[0].raw).toBe('\\d{3}');
    expect(nodes[0].desc).toBe('Exactly 3 times');
    expect(nodes[0].children?.[0].desc).toBe('Match a digit (0-9)');
    expect(nodes[1].desc).toBe('Literal text "-"');
    expect(nodes[2].raw).toBe('\\d{4}');
    expect(nodes[2].desc).toBe('Exactly 4 times');
  });

  it('explains a character class', () => {
    const { ok, nodes } = explainRegex('[a-z0-9_]');
    expect(ok).toBe(true);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].raw).toBe('[a-z0-9_]');
    expect(nodes[0].desc).toBe('Any one of: a to z, 0 to 9, "_"');
  });

  it('explains a negated character class', () => {
    const { nodes } = explainRegex('[^abc]');
    expect(nodes[0].desc).toBe('Any character except: "a", "b", "c"');
  });

  it('explains an alternation', () => {
    const { ok, nodes } = explainRegex('cat|dog');
    expect(ok).toBe(true);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].desc).toBe('Match one of these alternatives');
    expect(nodes[0].children).toHaveLength(2);
    expect(nodes[0].children?.[0].desc).toBe('Option 1');
    expect(nodes[0].children?.[0].raw).toBe('cat');
    expect(nodes[0].children?.[1].raw).toBe('dog');
  });

  it('explains an anchored pattern', () => {
    const { nodes } = explainRegex('^\\d+$');
    expect(nodes[0].desc).toBe('Start of string (or line, with the m flag)');
    expect(nodes[1].desc).toBe('One or more times (greedy — as many as possible)');
    expect(nodes[1].children?.[0].desc).toBe('Match a digit (0-9)');
    expect(nodes[2].desc).toBe('End of string (or line, with the m flag)');
  });

  it('returns an empty result for an empty pattern', () => {
    expect(explainRegex('')).toEqual({ ok: true, nodes: [] });
  });

  it('falls back forgivingly on an unbalanced/invalid pattern', () => {
    // An unbalanced ')' leaves a remainder rather than throwing.
    const { ok, nodes } = explainRegex('abc)def');
    expect(ok).toBe(true);
    const remainder = nodes.find((n) => n.desc === 'Unparsed remainder');
    expect(remainder).toBeDefined();
    expect(remainder?.raw).toBe(')def');
  });
});

describe('testRegex', () => {
  it('returns every match with its index', () => {
    const { ok, matches } = testRegex('\\d+', 'g', 'a1 bb22 ccc333');
    expect(ok).toBe(true);
    expect(matches.map((m) => m.match)).toEqual(['1', '22', '333']);
    expect(matches.map((m) => m.index)).toEqual([1, 5, 11]);
  });

  it('forces the global flag even when not provided', () => {
    const { matches } = testRegex('a', '', 'banana');
    expect(matches.map((m) => m.index)).toEqual([1, 3, 5]);
  });

  it('honors the case-insensitive flag', () => {
    const { matches } = testRegex('foo', 'i', 'FOO foo Foo');
    expect(matches).toHaveLength(3);
  });

  it('captures group values', () => {
    const { matches } = testRegex('(\\d{4})-(\\d{2})', 'g', '2026-06');
    expect(matches).toHaveLength(1);
    expect(matches[0].match).toBe('2026-06');
    expect(matches[0].groups).toEqual([
      { name: '$1', value: '2026' },
      { name: '$2', value: '06' },
    ]);
  });

  it('returns an empty result for an empty pattern', () => {
    expect(testRegex('', 'g', 'anything')).toEqual({ ok: true, matches: [] });
  });

  it('reports an error for an invalid pattern instead of throwing', () => {
    const { ok, error, matches } = testRegex('(', '', 'x');
    expect(ok).toBe(false);
    expect(error).toBeTruthy();
    expect(matches).toEqual([]);
  });

  it('does not loop forever on empty matches', () => {
    const { matches } = testRegex('a*', '', 'aXa');
    // One match per position (incl. zero-width) — bounded, not infinite.
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBeLessThan(10);
  });
});

describe('static reference data', () => {
  it('exports flags including the standard JS flags', () => {
    expect(REGEX_FLAGS.map((f) => f.flag)).toEqual(['g', 'i', 'm', 's', 'u', 'y']);
  });

  it('exports a grouped block palette', () => {
    expect(REGEX_BLOCKS.map((g) => g.group)).toEqual(['Characters', 'Quantifiers', 'Anchors & groups']);
    expect(REGEX_BLOCKS.every((g) => g.blocks.length > 0)).toBe(true);
  });

  it('exports recipes whose patterns compile', () => {
    const labels = REGEX_RECIPES.map((r) => r.label);
    expect(labels).toEqual(['Email', 'URL', 'Digits only', 'Hex color', 'ISO date', 'IPv4']);
    for (const recipe of REGEX_RECIPES) {
      expect(() => new RegExp(recipe.pattern, recipe.flags)).not.toThrow();
    }
  });

  it('has a working ISO-date recipe', () => {
    const iso = REGEX_RECIPES.find((r) => r.label === 'ISO date');
    const { matches } = testRegex(iso?.pattern ?? '', iso?.flags ?? '', 'born 2026-06-12 today');
    expect(matches.map((m) => m.match)).toEqual(['2026-06-12']);
  });
});
