import { describe, expect, test } from 'bun:test';
import { analyzeTerms } from './findterms';

const files = [
  { path: 'a.ts', content: "export const apiToken = 'x';\nconst version = '1.2.3';" },
  { path: 'b.ts', content: "import { foo } from './a';\nconsole.log(version);" },
  { path: 'c.txt', content: 'plain text, no secrets here' },
];

describe('analyzeTerms', () => {
  test('reports expected terms with the files they appear in', () => {
    const { found, missing } = analyzeTerms(files, ['version'], []);
    expect(missing).toEqual([]);
    expect(found).toEqual([{ term: 'version', files: ['a.ts', 'b.ts'] }]);
  });

  test('lists expected terms with zero matches as missing', () => {
    const { found, missing } = analyzeTerms(files, ['version', 'nope'], []);
    expect(found.map((h) => h.term)).toEqual(['version']);
    expect(missing).toEqual(['nope']);
  });

  test('flags unexpected terms that appear', () => {
    const { unexpectedFound } = analyzeTerms(files, [], ['apiToken']);
    expect(unexpectedFound).toEqual([{ term: 'apiToken', files: ['a.ts'] }]);
  });

  test('treats terms as regex', () => {
    const { found } = analyzeTerms(files, ['\\d+\\.\\d+\\.\\d+'], []);
    expect(found).toEqual([{ term: '\\d+\\.\\d+\\.\\d+', files: ['a.ts'] }]);
  });

  test('falls back to literal substring for invalid regex', () => {
    const { found } = analyzeTerms(
      [{ path: 'x.ts', content: 'value = a(b' }],
      ['a(b'], // invalid regex (unbalanced paren)
      [],
    );
    expect(found).toEqual([{ term: 'a(b', files: ['x.ts'] }]);
  });
});
