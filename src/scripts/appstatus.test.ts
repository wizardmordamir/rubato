import { describe, expect, test } from 'bun:test';
import type { BranchTracking } from '../lib/git';
import { classifyBranch } from './appstatus';

const bt = (over: Partial<BranchTracking> & { name: string }): BranchTracking => ({
  upstream: '',
  ahead: 0,
  behind: 0,
  gone: false,
  ...over,
});

describe('classifyBranch', () => {
  const remote = new Set(['main', 'feat/login', 'feat/pushed-untracked']);

  test('tracked + in sync → synced, exists remotely', () => {
    const b = classifyBranch(bt({ name: 'main', upstream: 'origin/main' }), remote, 'main');
    expect(b.state).toBe('synced');
    expect(b.existsRemotely).toBe(true);
    expect(b.isCurrent).toBe(true);
  });

  test('tracked + ahead/behind → diverged', () => {
    const b = classifyBranch(
      bt({ name: 'feat/login', upstream: 'origin/feat/login', ahead: 3, behind: 1 }),
      remote,
      'main',
    );
    expect(b.state).toBe('diverged');
    expect(b.ahead).toBe(3);
    expect(b.behind).toBe(1);
    expect(b.existsRemotely).toBe(true);
  });

  test('upstream gone → gone, no longer remote', () => {
    const b = classifyBranch(bt({ name: 'feat/done', upstream: 'origin/feat/done', gone: true }), remote, 'main');
    expect(b.state).toBe('gone');
    expect(b.existsRemotely).toBe(false);
  });

  test('no upstream but origin has the branch → untracked', () => {
    const b = classifyBranch(bt({ name: 'feat/pushed-untracked' }), remote, 'main');
    expect(b.state).toBe('untracked');
    expect(b.existsRemotely).toBe(true);
  });

  test('no upstream and not on origin → local-only', () => {
    const b = classifyBranch(bt({ name: 'scratch' }), remote, 'main');
    expect(b.state).toBe('local');
    expect(b.existsRemotely).toBe(false);
  });
});
