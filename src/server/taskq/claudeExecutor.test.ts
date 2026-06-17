import { describe, expect, test } from 'bun:test';
import type { TaskRow } from 'cwip/taskq';
import { agentPath, buildWorkerPrompt, makeClaudeExecutor, parseClaudeResult } from './claudeExecutor';
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
  recur_n: null,
  recur_last: null,
  recur_interval_ms: null,
  recur_next_at: null,
  is_template: 0,
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
    const res = await exec(task({ repo: 'ru', model: 'sonnet' }), { index: 0, workerId: 'w', worktree: 'wt', filters: {} });
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
