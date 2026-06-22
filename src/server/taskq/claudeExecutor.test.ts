import { describe, expect, test } from 'bun:test';
import type { TaskRow } from 'cwip/taskq';
import {
  agentPath,
  buildWorkerPrompt,
  isPermanentFailureMessage,
  isUsageLimitMessage,
  makeClaudeExecutor,
  PERMANENT_FAILURE_MARKER,
  parseClaudeResult,
} from './claudeExecutor';
import { loadTaskqConfig } from './config';
import { TASKQ_LAUNCHD_LABEL, taskqLaunchdPlist } from './launchd';

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 1,
  ord: 0,
  status: 'claimed',
  slug: null,
  title: 'do a thing',
  body: null,
  repo: null,
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
  parent_id: null,
  note: null,
  triage_state: null,
  complexity: null,
  created_at: '',
  updated_at: '',
  ...over,
});

describe('parseClaudeResult', () => {
  test('success envelope → ok + tokens', () => {
    const r = parseClaudeResult(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'landed it',
        usage: { output_tokens: 1234 },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.outputTokens).toBe(1234);
    expect(r.summary).toBe('landed it');
  });
  test('error envelope → not ok with reason', () => {
    const r = parseClaudeResult(JSON.stringify({ subtype: 'error_max_turns', is_error: true, result: 'gave up' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('gave up');
  });
  test('unparseable → not ok', () => {
    expect(parseClaudeResult('not json at all').ok).toBe(false);
  });
});

describe('agentPath', () => {
  test('includes ~/.local/bin (claude) and ~/.bun/bin (bun)', () => {
    const p = agentPath();
    expect(p).toContain('.local/bin');
    expect(p).toContain('.bun/bin');
  });
});

describe('buildWorkerPrompt', () => {
  test('embeds the task + CLAUDE.md workflow instruction', () => {
    const p = buildWorkerPrompt(task({ id: 7, title: 'fix bug', repo: 'ru' }));
    expect(p).toContain('TASK #7');
    expect(p).toContain('CLAUDE.md');
  });

  test('documents the permanent-failure marker so the worker can opt out of retries', () => {
    const p = buildWorkerPrompt(task());
    expect(p).toContain(PERMANENT_FAILURE_MARKER);
  });
});

describe('permanent-failure classification', () => {
  test('isPermanentFailureMessage matches only the explicit marker', () => {
    expect(isPermanentFailureMessage(`${PERMANENT_FAILURE_MARKER} this needs a human credential`)).toBe(true);
    expect(isPermanentFailureMessage('taskq-permanent: lowercased works too')).toBe(true);
    expect(isPermanentFailureMessage('the task failed but might work next time')).toBe(false);
    expect(isPermanentFailureMessage('')).toBe(false);
    expect(isPermanentFailureMessage(null)).toBe(false);
  });

  test('parseClaudeResult flags a marked failure permanent; ordinary failures + successes are not', () => {
    const marked = parseClaudeResult(
      JSON.stringify({ subtype: 'error', is_error: true, result: `${PERMANENT_FAILURE_MARKER} cannot proceed` }),
    );
    expect(marked.ok).toBe(false);
    expect(marked.permanent).toBe(true);

    const ordinary = parseClaudeResult(JSON.stringify({ subtype: 'error', is_error: true, result: 'tsc failed' }));
    expect(ordinary.permanent).toBe(false);

    const success = parseClaudeResult(
      JSON.stringify({ subtype: 'success', result: `done ${PERMANENT_FAILURE_MARKER}`, usage: {} }),
    );
    // A successful run is never permanent-failed, even if the marker appears in prose.
    expect(success.ok).toBe(true);
    expect(success.permanent).toBe(false);
  });
});

describe('makeClaudeExecutor (injected spawn)', () => {
  test('passes model + json flags + PATH; parses the envelope', async () => {
    let seen: { cmd: string[]; cwd: string; env: Record<string, string> } | null = null;
    const exec = makeClaudeExecutor(loadTaskqConfig(), async (cmd, cwd, env) => {
      seen = { cmd, cwd, env };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ subtype: 'success', is_error: false, result: 'ok', usage: { output_tokens: 5 } }),
      };
    });
    const res = await exec(task({ repo: 'ru', model: 'sonnet' }), {
      index: 0,
      workerId: 'w',
      worktree: 'wt',
      filters: {},
    });
    expect(res.ok).toBe(true);
    expect(res.outputTokens).toBe(5);
    expect(seen!.cmd).toContain('claude-sonnet-4-6');
    expect(seen!.cmd).toContain('--output-format');
    expect(seen!.cwd).toContain('rubato');
    expect(seen!.env.PATH).toContain('.local/bin');
  });

  test('nonzero exit → failure', async () => {
    const exec = makeClaudeExecutor(loadTaskqConfig(), async () => ({ exitCode: 1, stdout: '' }));
    expect((await exec(task(), { index: 0, workerId: 'w', worktree: 'wt', filters: {} })).ok).toBe(false);
  });

  test('passes the configured taskTimeoutMs to the spawn', async () => {
    let seenOpts: { timeoutMs?: number } | undefined;
    const exec = makeClaudeExecutor(loadTaskqConfig(), async (_cmd, _cwd, _env, opts) => {
      seenOpts = opts;
      return { exitCode: 0, stdout: JSON.stringify({ subtype: 'success', is_error: false, result: 'ok' }) };
    });
    await exec(task(), { index: 0, workerId: 'w', worktree: 'wt', filters: {} });
    expect(seenOpts?.timeoutMs).toBe(loadTaskqConfig().taskTimeoutMs);
  });

  test('a timed-out run → failure with a timeout reason, never rate-limited', async () => {
    const exec = makeClaudeExecutor(loadTaskqConfig(), async () => ({ exitCode: 143, stdout: '', timedOut: true }));
    const res = await exec(task(), { index: 0, workerId: 'w', worktree: 'wt', filters: {} });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('timed out');
    expect(res.rateLimited).toBe(false);
  });

  test('nonzero exit with a usage-limit message on STDERR → rateLimited', async () => {
    const exec = makeClaudeExecutor(loadTaskqConfig(), async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Claude usage limit reached. Resets at 5pm',
    }));
    const res = await exec(task(), { index: 0, workerId: 'w', worktree: 'wt', filters: {} });
    expect(res.ok).toBe(false);
    expect(res.rateLimited).toBe(true);
  });
});

describe('usage-limit classification', () => {
  test('isUsageLimitMessage matches real limit phrasings, ignores ordinary failures', () => {
    expect(isUsageLimitMessage('Claude usage limit reached. Resets at 5pm')).toBe(true);
    expect(isUsageLimitMessage('Error: 429 Too Many Requests')).toBe(true);
    expect(isUsageLimitMessage('overloaded_error')).toBe(true);
    expect(isUsageLimitMessage('tsc failed with 3 errors')).toBe(false);
    expect(isUsageLimitMessage('')).toBe(false);
    expect(isUsageLimitMessage(null)).toBe(false);
  });

  test('parseClaudeResult flags a usage-limit error as rateLimited', () => {
    const r = parseClaudeResult(
      JSON.stringify({ subtype: 'error', is_error: true, result: 'Claude usage limit reached.' }),
    );
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(true);
  });

  test('parseClaudeResult does NOT flag an ordinary failure', () => {
    const r = parseClaudeResult(JSON.stringify({ subtype: 'error', is_error: true, result: 'could not find file' }));
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(false);
  });

  test('parseClaudeResult success is never rateLimited', () => {
    const r = parseClaudeResult(JSON.stringify({ subtype: 'success', result: 'done', usage: { output_tokens: 10 } }));
    expect(r.ok).toBe(true);
    expect(r.rateLimited).toBe(false);
    expect(r.outputTokens).toBe(10);
  });
});

describe('launchd plist', () => {
  test('has the taskq label, interval, and a PATH env', () => {
    const plist = taskqLaunchdPlist({
      bunPath: '/bun',
      rubatoDir: '/ru',
      intervalSeconds: 300,
      logDir: '/log',
      path: '/p/.local/bin:/usr/bin',
    });
    expect(plist).toContain(TASKQ_LAUNCHD_LABEL);
    expect(plist).toContain('<integer>300</integer>');
    expect(plist).toContain('EnvironmentVariables');
    expect(plist).toContain('/p/.local/bin');
  });
});
