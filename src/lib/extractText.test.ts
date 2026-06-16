import { describe, expect, test } from 'bun:test';
import { extractValue, extractValues } from './extractText';

const JENKINS_TEXT = [
  'Build parameters for the deploy:',
  'my-app-svc',
  '  promoted image:',
  'sha256:abc123def456',
  'version: 4.2.1',
  'task: TASK-9988',
].join('\n');

describe('extractValue — regex', () => {
  test('returns a capture group', () => {
    expect(extractValue(JENKINS_TEXT, { kind: 'regex', pattern: 'version: (\\d+\\.\\d+\\.\\d+)', group: 1 })).toBe(
      '4.2.1',
    );
  });
  test('group 0 (default) is the whole match; no match → null', () => {
    expect(extractValue(JENKINS_TEXT, { kind: 'regex', pattern: 'TASK-\\d+' })).toBe('TASK-9988');
    expect(extractValue(JENKINS_TEXT, { kind: 'regex', pattern: 'nope-\\d+' })).toBeNull();
  });
});

describe('extractValue — afterAnchor (the task-42 example)', () => {
  test('finds the app name, then the next line starting with sha256:', () => {
    expect(extractValue(JENKINS_TEXT, { kind: 'afterAnchor', anchor: 'my-app-svc', startsWith: 'sha256:' })).toBe(
      'sha256:abc123def456',
    );
  });
  test('scans forward past intervening lines for the prefix', () => {
    // the sha line is two lines below the anchor (a 'promoted image:' line between)
    const v = extractValue(JENKINS_TEXT, { kind: 'afterAnchor', anchor: 'Build parameters', startsWith: 'sha256:' });
    expect(v).toBe('sha256:abc123def456');
  });
  test('a regex `pattern` after the anchor returns its group', () => {
    expect(
      extractValue(JENKINS_TEXT, { kind: 'afterAnchor', anchor: 'my-app-svc', pattern: 'version: (.+)', group: 1 }),
    ).toBe('4.2.1');
  });
  test('no startsWith/pattern → the next line (skipBlank skips blanks)', () => {
    const t = 'anchor\n\n\nfirst real';
    expect(extractValue(t, { kind: 'afterAnchor', anchor: 'anchor' })).toBe('');
    expect(extractValue(t, { kind: 'afterAnchor', anchor: 'anchor', skipBlank: true })).toBe('first real');
  });
  test('anchorIsRegex matches the anchor as a pattern; missing anchor → null', () => {
    expect(
      extractValue(JENKINS_TEXT, {
        kind: 'afterAnchor',
        anchor: 'my-app-\\w+',
        anchorIsRegex: true,
        startsWith: 'sha256:',
      }),
    ).toBe('sha256:abc123def456');
    expect(extractValue(JENKINS_TEXT, { kind: 'afterAnchor', anchor: 'absent', startsWith: 'x' })).toBeNull();
  });
});

describe('extractValue — lineContaining', () => {
  test('returns the matching line, or a sub-capture from it', () => {
    expect(extractValue(JENKINS_TEXT, { kind: 'lineContaining', contains: 'task:' })).toBe('task: TASK-9988');
    expect(
      extractValue(JENKINS_TEXT, { kind: 'lineContaining', contains: 'task:', pattern: '(TASK-\\d+)', group: 1 }),
    ).toBe('TASK-9988');
    expect(extractValue(JENKINS_TEXT, { kind: 'lineContaining', contains: 'nothing-here' })).toBeNull();
  });
});

describe('extractValues', () => {
  test('collects multiple named values, omitting misses', () => {
    expect(
      extractValues(JENKINS_TEXT, {
        sha: { kind: 'afterAnchor', anchor: 'my-app-svc', startsWith: 'sha256:' },
        version: { kind: 'regex', pattern: 'version: (.+)', group: 1 },
        missing: { kind: 'regex', pattern: 'zzz(\\d)', group: 1 },
      }),
    ).toEqual({ sha: 'sha256:abc123def456', version: '4.2.1' });
  });
});
