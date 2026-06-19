import { describe, expect, test } from 'bun:test';
import {
  asyncShapeCheck,
  extractCodeBlocks,
  formatIssuesForRepair,
  lintCodePaths,
  runCodeChecks,
  syntaxCheckBlocks,
} from './codeCheck';

const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``;

describe('extractCodeBlocks', () => {
  test('extracts only code-language fences, indexed 1-based', () => {
    const md = `intro\n${fence('ts', 'const a = 1;')}\nmid\n${fence('json', '{"x":1}')}\n${fence('tsx', '<A/>;')}`;
    const blocks = extractCodeBlocks(md);
    expect(blocks.map((b) => b.lang)).toEqual(['ts', 'tsx']); // json skipped
    expect(blocks[0]?.index).toBe(1);
    expect(blocks[1]?.index).toBe(2);
  });

  test('returns [] when there are no code fences', () => {
    expect(extractCodeBlocks('just prose, no code')).toEqual([]);
  });
});

describe('syntaxCheckBlocks', () => {
  test('flags a genuine syntax error', () => {
    const blocks = extractCodeBlocks(fence('ts', 'function broken( {\n  return 1;'));
    const issues = syntaxCheckBlocks(blocks);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.rule).toBe('syntax');
  });

  test('passes clean TypeScript (incl. type annotations, no imports needed)', () => {
    const blocks = extractCodeBlocks(
      fence('ts', 'const n: number = 1;\nexport function f(x: string): string { return x; }'),
    );
    expect(syntaxCheckBlocks(blocks)).toEqual([]);
  });
});

describe('asyncShapeCheck', () => {
  test('flags awaiting callback-style exec', () => {
    const blocks = extractCodeBlocks(fence('ts', "const out = await exec('ls', (e, stdout) => stdout);"));
    const issues = asyncShapeCheck(blocks);
    expect(issues.some((i) => i.rule === 'await-callback-exec' || i.rule === 'await-with-callback')).toBe(true);
  });

  test('does NOT flag top-level await (valid in Bun/ESM)', () => {
    const blocks = extractCodeBlocks(
      fence('ts', "const res = await fetch('https://example.com');\nconst body = await res.text();"),
    );
    expect(asyncShapeCheck(blocks)).toEqual([]);
  });

  test('does NOT flag a properly promisified exec', () => {
    const code = [
      "import { promisify } from 'node:util';",
      "import { exec } from 'node:child_process';",
      'const execAsync = promisify(exec);',
      "const { stdout } = await execAsync('git status');",
    ].join('\n');
    expect(asyncShapeCheck(extractCodeBlocks(fence('ts', code)))).toEqual([]);
  });
});

describe('lintCodePaths', () => {
  test('flags a relative path inside a filesystem read', () => {
    const blocks = extractCodeBlocks(fence('ts', "const txt = readFileSync('./data.txt', 'utf8');"));
    const issues = lintCodePaths(blocks);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe('relative-fs-path');
  });

  test('does NOT flag relative module imports/requires', () => {
    const code = "import x from './utils';\nconst y = require('../lib/y');";
    expect(lintCodePaths(extractCodeBlocks(fence('ts', code)))).toEqual([]);
  });

  test('does NOT flag an anchored path', () => {
    const code = "import { join } from 'node:path';\nconst p = readFileSync(join(import.meta.dir, 'data.txt'));";
    expect(lintCodePaths(extractCodeBlocks(fence('ts', code)))).toEqual([]);
  });
});

describe('runCodeChecks + formatIssuesForRepair', () => {
  test('clean answer → no issues', async () => {
    const md = `Here you go:\n${fence('ts', 'export const add = (a: number, b: number): number => a + b;')}`;
    const { issues } = await runCodeChecks(md);
    expect(issues).toEqual([]);
  });

  test('buggy answer → issues, formatted for repair', async () => {
    const md = `Try:\n${fence('ts', "const out = await exec('ls', (e, o) => o);\nconst t = readFileSync('./x.txt');")}`;
    const { issues } = await runCodeChecks(md);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    const text = formatIssuesForRepair(issues);
    expect(text).toContain('block 1');
  });

  test('no code blocks → no issues, no work', async () => {
    expect((await runCodeChecks('plain prose')).issues).toEqual([]);
  });
});
