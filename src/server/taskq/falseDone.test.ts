import { describe, expect, test } from 'bun:test';
import { type DoneEvidence, decideDone } from './falseDone';

/** A baseline "everything's fine" evidence set; override per case. */
const ev = (over: Partial<DoneEvidence> = {}): DoneEvidence => ({
  enforced: true,
  landedCommits: 3,
  buildChecked: false,
  buildGreen: undefined,
  toleratedRed: false,
  ...over,
});

describe('decideDone', () => {
  test('accepts a landing with no build check (landed code, build not run)', () => {
    const v = decideDone(ev({ landedCommits: 2 }));
    expect(v.accept).toBe(true);
  });

  test('accepts a landing whose integration build is green', () => {
    const v = decideDone(ev({ landedCommits: 1, buildChecked: true, buildGreen: true }));
    expect(v.accept).toBe(true);
  });

  test('rejects an EMPTY-done (zero landed commits) → needs_input', () => {
    const v = decideDone(ev({ landedCommits: 0 }));
    expect(v.accept).toBe(false);
    if (v.accept) throw new Error('unreachable');
    expect(v.reason).toBe('empty-done');
    expect(v.status).toBe('needs_input');
    expect(v.disposition).toBe('needs_owner'); // rfc-31j: a revert is never a bare hold
    expect(v.note).toContain('ZERO commits');
  });

  test('empty-done wins even if a (stale) build somehow read green', () => {
    const v = decideDone(ev({ landedCommits: 0, buildChecked: true, buildGreen: true }));
    expect(v.accept).toBe(false);
    if (v.accept) throw new Error('unreachable');
    expect(v.reason).toBe('empty-done');
  });

  test('rejects a REGRESSION (was green, now red) → on_hold', () => {
    const v = decideDone(ev({ landedCommits: 4, buildChecked: true, buildGreen: false, toleratedRed: false }));
    expect(v.accept).toBe(false);
    if (v.accept) throw new Error('unreachable');
    expect(v.reason).toBe('regression');
    expect(v.status).toBe('on_hold');
    expect(v.disposition).toBe('needs_owner'); // rfc-31j: a revert is never a bare hold
    expect(v.note).toContain('REGRESSED');
  });

  test('tolerates a red build that was ALREADY red/unknown (not this task’s regression)', () => {
    const v = decideDone(ev({ landedCommits: 4, buildChecked: true, buildGreen: false, toleratedRed: true }));
    expect(v.accept).toBe(true);
  });

  test('a non-flow repo (not enforced) is always accepted, even with zero commits', () => {
    const v = decideDone(ev({ enforced: false, landedCommits: 0 }));
    expect(v.accept).toBe(true);
  });
});
