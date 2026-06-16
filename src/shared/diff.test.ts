import { describe, expect, test } from 'bun:test';
import { parseUnifiedDiff } from './diff';

describe('parseUnifiedDiff', () => {
  test('empty / whitespace input → no files', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   \n  ')).toEqual([]);
  });

  test('a modified file: context/add/del lines carry the right old+new numbers', () => {
    const diff = [
      'diff --git a/apps.template.json b/apps.template.json',
      'index 1111111..2222222 100644',
      '--- a/apps.template.json',
      '+++ b/apps.template.json',
      '@@ -1,4 +1,4 @@',
      ' line one',
      '-old two',
      '+new two',
      ' line three',
      '',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file.path).toBe('apps.template.json');
    expect(file.kind).toBe('modified');
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);

    expect(file.hunks[0].lines).toEqual([
      { type: 'context', text: 'line one', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'old two', oldNo: 2 },
      { type: 'add', text: 'new two', newNo: 2 },
      { type: 'context', text: 'line three', oldNo: 3, newNo: 3 },
    ]);
  });

  test('a never-committed file (git diff --no-index) is all additions', () => {
    const diff = [
      'diff --git a/dev/null b/apps.template.json',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/apps.template.json',
      '@@ -0,0 +1,2 @@',
      '+first',
      '+second',
      '',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file.kind).toBe('added');
    expect(file.path).toBe('apps.template.json');
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
    expect(file.hunks[0].lines).toEqual([
      { type: 'add', text: 'first', newNo: 1 },
      { type: 'add', text: 'second', newNo: 2 },
    ]);
  });

  test('"\\ No newline at end of file" is ignored (no phantom line / numbering)', () => {
    const diff = [
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      '@@ -1 +1 @@',
      '-a',
      '\\ No newline at end of file',
      '+b',
      '\\ No newline at end of file',
    ].join('\n');

    const [file] = parseUnifiedDiff(diff);
    expect(file.hunks[0].lines).toEqual([
      { type: 'del', text: 'a', oldNo: 1 },
      { type: 'add', text: 'b', newNo: 1 },
    ]);
  });

  test('multiple files are split into separate entries', () => {
    const diff = [
      'diff --git a/one.txt b/one.txt',
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/two.txt b/two.txt',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -0,0 +1 @@',
      '+new',
    ].join('\n');

    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['one.txt', 'two.txt']);
    expect(files[1].additions).toBe(1);
  });
});
