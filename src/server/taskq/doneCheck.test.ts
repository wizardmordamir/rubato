import { describe, expect, test } from 'bun:test';
import type { TaskRow } from 'cwip/taskq';
import type { TaskqConfig } from './config';
import { type DoneCheckDeps, integrationWorktree, makeDoneGuard } from './doneCheck';
import type { FalseDoneAlert } from './falseDone';
import type { TaskResult } from './orchestrator';

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 31,
  ord: 0,
  status: 'claimed',
  slug: 'rfc-31',
  title: 'do the refactor',
  body: null,
  repo: 'ru',
  model: null,
  think: null,
  fast: 0,
  group_key: null,
  serial_group: null,
  recur_n: null,
  recur_last: null,
  recur_interval_ms: null,
  recur_next_at: null,
  is_template: 0,
  is_saved: 0,
  attempts: 0,
  max_attempts: null,
  noop_ok: 0,
  parent_id: null,
  note: null,
  hold_disposition: null,
  resolver_ref: null,
  triage_state: null,
  complexity: null,
  created_at: '',
  updated_at: '',
  ...over,
});

const config = (over: Partial<TaskqConfig> = {}): TaskqConfig => ({
  jobs: 1,
  model: 'opus',
  leaseTtlMs: 60_000,
  taskTimeoutMs: 60_000,
  maxAttempts: 3,
  retryBackoff: {},
  usagePollMinutes: 0,
  usageCostPollMinutes: 0,
  falseDoneBuildCheck: true,
  repos: { ru: '/repos/rubato' },
  ...over,
});

const SUCCESS: TaskResult = { ok: true, outputTokens: 100 };

/**
 * A scripted world the fake git/build/fs read from. `head` is the integration tip
 * (snapshot reads it as `before`, verify re-reads it as `after`); `landed` is what
 * `rev-list --count` returns; `buildGreen`/`knownGreen` drive the regression check.
 * `commitSubjects` is what `git log --format=%s` returns (undefined = git error =
 * no subject info, so attribution falls back to the raw landed count).
 */
interface World {
  head: string;
  landed: number;
  buildGreen: boolean;
  knownGreen: boolean | undefined;
  hasIntegBranch: boolean;
  worktreeExists: boolean;
  /** Commit subjects in the run window (controls attribution). Omit to simulate no subject info. */
  commitSubjects?: string[];
}

function fakeDeps(w: World, alerts: FalseDoneAlert[], buildCalls: { count: number }): DoneCheckDeps {
  return {
    git: (args) => {
      if (args[0] === 'rev-parse') return w.hasIntegBranch ? { code: 0, out: `${w.head}\n` } : { code: 128, out: '' };
      if (args[0] === 'rev-list') return { code: 0, out: `${w.landed}\n` };
      if (args[0] === 'log') {
        // `git log --format=%s before..after` -- return scripted subjects or simulate error.
        if (w.commitSubjects === undefined) return { code: 1, out: '' };
        return { code: 0, out: w.commitSubjects.length > 0 ? `${w.commitSubjects.join('\n')}\n` : '' };
      }
      return { code: 1, out: '' };
    },
    build: () => {
      buildCalls.count++;
      return { code: w.buildGreen ? 0 : 1, out: '' };
    },
    knownGreen: () => w.knownGreen,
    exists: () => w.worktreeExists,
    alert: (r) => alerts.push(r),
    now: () => 1_700_000_000_000,
  };
}

const CTX = { index: 0, workerId: 'w0', worktree: '_w0', filters: {} };

async function run(w: World, opts: { cfg?: Partial<TaskqConfig>; landAfter?: string } = {}) {
  const alerts: FalseDoneAlert[] = [];
  const buildCalls = { count: 0 };
  const guard = makeDoneGuard(config(opts.cfg), fakeDeps(w, alerts, buildCalls));
  const snap = await guard.snapshot(task(), CTX);
  // Simulate the task's run window: the integration tip may advance before verify.
  if (opts.landAfter !== undefined) w.head = opts.landAfter;
  const verdict = await guard.verify(task(), SUCCESS, snap, CTX);
  return { verdict, alerts, buildCalls };
}

describe('makeDoneGuard', () => {
  test('integrationWorktree derives the -integration sibling', () => {
    expect(integrationWorktree('/repos/rubato')).toBe('/repos/rubato-integration');
  });

  test('EMPTY-DONE: integration tip never moved → reverted to needs_input + alerted', async () => {
    const w: World = {
      head: 'sha0',
      landed: 0,
      buildGreen: true,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
    };
    const { verdict, alerts, buildCalls } = await run(w); // no landAfter → head unchanged
    expect(verdict.accept).toBe(false);
    if (verdict.accept) throw new Error('unreachable');
    expect(verdict.reason).toBe('empty-done');
    expect(verdict.status).toBe('needs_input');
    expect(buildCalls.count).toBe(0); // nothing landed → no build
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ taskId: 31, slug: 'rfc-31', repo: 'ru', reason: 'empty-done' });
  });

  test('REGRESSING-DONE: landed code but a known-green integration went red → on_hold + alerted', async () => {
    const w: World = {
      head: 'sha0',
      landed: 2,
      buildGreen: false,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
    };
    const { verdict, alerts, buildCalls } = await run(w, { landAfter: 'sha1' });
    expect(verdict.accept).toBe(false);
    if (verdict.accept) throw new Error('unreachable');
    expect(verdict.reason).toBe('regression');
    expect(verdict.status).toBe('on_hold');
    expect(buildCalls.count).toBe(1); // code landed → build ran
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.reason).toBe('regression');
  });

  test('TOLERATED: integration was already red before the task → accepted (heal owns it)', async () => {
    const w: World = {
      head: 'sha0',
      landed: 2,
      buildGreen: false,
      knownGreen: false,
      hasIntegBranch: true,
      worktreeExists: true,
    };
    const { verdict, alerts } = await run(w, { landAfter: 'sha1' });
    expect(verdict.accept).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  test('CLEAN: landed code + green build → accepted, no alert', async () => {
    const w: World = {
      head: 'sha0',
      landed: 5,
      buildGreen: true,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
    };
    const { verdict, alerts, buildCalls } = await run(w, { landAfter: 'sha9' });
    expect(verdict.accept).toBe(true);
    expect(buildCalls.count).toBe(1);
    expect(alerts).toHaveLength(0);
  });

  test('build check disabled → landed code accepted without building (red build ignored)', async () => {
    const w: World = {
      head: 'sha0',
      landed: 5,
      buildGreen: false,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
    };
    const { verdict, buildCalls } = await run(w, { cfg: { falseDoneBuildCheck: false }, landAfter: 'sha9' });
    expect(verdict.accept).toBe(true);
    expect(buildCalls.count).toBe(0); // never built
  });

  test('NOT-ENFORCED: a repo without refactor/integration is accepted unconditionally', async () => {
    const w: World = {
      head: 'sha0',
      landed: 0,
      buildGreen: false,
      knownGreen: true,
      hasIntegBranch: false,
      worktreeExists: true,
    };
    const { verdict, alerts, buildCalls } = await run(w);
    expect(verdict.accept).toBe(true);
    expect(buildCalls.count).toBe(0);
    expect(alerts).toHaveLength(0);
  });

  test('NOT-ENFORCED: an unknown repo (no resolved root) is accepted', async () => {
    const w: World = {
      head: 'sha0',
      landed: 0,
      buildGreen: false,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
    };
    const alerts: FalseDoneAlert[] = [];
    const buildCalls = { count: 0 };
    const guard = makeDoneGuard(config(), fakeDeps(w, alerts, buildCalls));
    const t = task({ repo: 'nope' });
    const snap = await guard.snapshot(t, CTX);
    const verdict = await guard.verify(t, SUCCESS, snap, CTX);
    expect(verdict.accept).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  test('NOT-ENFORCED: a saved/recurring task is skipped (never cascades; may land no code)', async () => {
    const w: World = {
      head: 'sha0',
      landed: 0,
      buildGreen: false,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
    };
    for (const over of [{ is_saved: 1 }, { recur_interval_ms: 60_000 }, { recur_n: 5 }, { is_template: 1 }] as const) {
      const alerts: FalseDoneAlert[] = [];
      const guard = makeDoneGuard(config(), fakeDeps(w, alerts, { count: 0 }));
      const t = task(over);
      const verdict = await guard.verify(t, SUCCESS, await guard.snapshot(t, CTX), CTX);
      expect(verdict.accept).toBe(true); // even with zero landed commits
      expect(alerts).toHaveLength(0);
    }
  });

  test("build is skipped when the integration worktree is absent (can't build → no regression flag)", async () => {
    const w: World = {
      head: 'sha0',
      landed: 2,
      buildGreen: false,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: false,
    };
    const { verdict, buildCalls } = await run(w, { landAfter: 'sha1' });
    expect(verdict.accept).toBe(true); // landed code, build couldn't run → accept
    expect(buildCalls.count).toBe(0);
  });

  // ── Attribution tests ──────────────────────────────────────────────────────────

  test('SIBLING-MASKING: stamped commits in window carry another task id → treated as empty-done', async () => {
    // Two workers running concurrently on the same repo. Sibling (#99) lands first;
    // our task (#31) lands nothing. rawLanded=2 but none reference #31 or its slug.
    const w: World = {
      head: 'sha0',
      landed: 2,
      buildGreen: true,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
      commitSubjects: ['chore: land sibling work (#99)', 'fix: another sibling commit (#99)'],
    };
    const { verdict, alerts, buildCalls } = await run(w, { landAfter: 'sha2' });
    expect(verdict.accept).toBe(false);
    if (verdict.accept) throw new Error('unreachable');
    expect(verdict.reason).toBe('empty-done');
    expect(verdict.status).toBe('needs_input');
    expect(buildCalls.count).toBe(0); // attribution resolves to 0 → no build
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ taskId: 31, slug: 'rfc-31', repo: 'ru', reason: 'empty-done' });
  });

  test('ATTRIBUTION: commit referencing this task by #id is credited → accepted', async () => {
    const w: World = {
      head: 'sha0',
      landed: 3,
      buildGreen: true,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
      // Mix of sibling and this task's commit (#31).
      commitSubjects: ['chore: sibling work (#99)', 'feat: this task work (#31)', 'chore: sibling follow-up (#99)'],
    };
    const { verdict, alerts } = await run(w, { landAfter: 'sha3' });
    expect(verdict.accept).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  test('ATTRIBUTION: commit referencing this task by slug is credited → accepted', async () => {
    const w: World = {
      head: 'sha0',
      landed: 1,
      buildGreen: true,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
      commitSubjects: ['feat(rfc-31): wire up the refactor (#99 sibling also landed)'],
    };
    const { verdict, alerts } = await run(w, { landAfter: 'sha1' });
    expect(verdict.accept).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  test('ATTRIBUTION fallback: no stamp in any commit → raw landed count kept (backward compat)', async () => {
    const w: World = {
      head: 'sha0',
      landed: 2,
      buildGreen: true,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
      // Honest commits with no #N stamp -- worker pre-dates the attribution feature.
      commitSubjects: ['chore: update deps', 'fix: handle edge case'],
    };
    const { verdict, alerts } = await run(w, { landAfter: 'sha2' });
    expect(verdict.accept).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  test('ATTRIBUTION: id boundary -- #31 matches but #310 does not', async () => {
    const w: World = {
      head: 'sha0',
      landed: 2,
      buildGreen: true,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
      // #310 is a different task; should NOT be credited to task #31.
      commitSubjects: ['feat: work for a different task (#310)', 'chore: more work (#310)'],
    };
    const { verdict } = await run(w, { landAfter: 'sha2' });
    expect(verdict.accept).toBe(false);
    if (verdict.accept) throw new Error('unreachable');
    expect(verdict.reason).toBe('empty-done');
  });

  test('ATTRIBUTION: git log error → falls back to raw count (fail-open)', async () => {
    // commitSubjects: undefined → fake returns { code: 1 } → no subject info → fallback.
    const w: World = {
      head: 'sha0',
      landed: 2,
      buildGreen: true,
      knownGreen: true,
      hasIntegBranch: true,
      worktreeExists: true,
      // No commitSubjects → git log fails → fallback to raw count.
    };
    const { verdict, alerts } = await run(w, { landAfter: 'sha2' });
    expect(verdict.accept).toBe(true); // fail-open: treat as landed
    expect(alerts).toHaveLength(0);
  });
});
