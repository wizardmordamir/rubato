import { describe, expect, test } from 'bun:test';
import type { TaskRow } from 'cwip/taskq';
import { buildWorkerPrompt, makeClaudeExecutor, parseWorkerResult } from './claudeExecutor';
import { loadTaskqConfig } from './config';
import { taskqLaunchdPlist, TASKQ_LAUNCHD_LABEL } from './launchd';

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
  parent_id: null,
  note: null,
  triage_state: null,
  complexity: null,
  created_at: '',
  updated_at: '',
  ...over,
});

describe('parseWorkerResult', () => {
  test('reads the trailing ok JSON line', () => {
    expect(parseWorkerResult('blah\nworking…\n{"ok": true, "commit": "abc1234", "summary": "done"}')).toEqual({
      ok: true,
      commit: 'abc1234',
      summary: 'done',
    });
  });
  test('reads a failure line', () => {
    expect(parseWorkerResult('nope\n{"ok": false, "reason": "blocked"}').ok).toBe(false);
  });
  test('no result line → failure', () => {
    expect(parseWorkerResult('just chatter, no json').ok).toBe(false);
  });
});

describe('buildWorkerPrompt', () => {
  test('embeds the task + asks for a result line', () => {
    const p = buildWorkerPrompt(task({ id: 7, title: 'fix bug', repo: 'ru', slug: 'x' }));
    expect(p).toContain('TASK #7');
    expect(p).toContain('fix bug');
    expect(p).toContain('"ok"');
  });
});

describe('makeClaudeExecutor (injected spawn)', () => {
  test('passes the model + cwd and parses the result', async () => {
    const config = loadTaskqConfig();
    let seen: { cmd: string[]; cwd: string } | null = null;
    const exec = makeClaudeExecutor(config, async (cmd, cwd) => {
      seen = { cmd, cwd };
      return { exitCode: 0, stdout: '{"ok": true, "commit": "z"}' };
    });
    const res = await exec(task({ repo: 'ru', model: 'sonnet' }), { index: 0, workerId: 'w', worktree: 'wt', filters: {} });
    expect(res).toEqual({ ok: true, commit: 'z' });
    expect(seen!.cmd).toContain('claude-sonnet-4-6');
    expect(seen!.cwd).toContain('rubato');
  });

  test('nonzero exit → failure', async () => {
    const exec = makeClaudeExecutor(loadTaskqConfig(), async () => ({ exitCode: 1, stdout: '' }));
    expect((await exec(task(), { index: 0, workerId: 'w', worktree: 'wt', filters: {} })).ok).toBe(false);
  });
});

describe('launchd plist', () => {
  test('uses the distinct taskq label + interval', () => {
    const plist = taskqLaunchdPlist({ bunPath: '/bun', rubatoDir: '/ru', intervalSeconds: 300, logDir: '/log' });
    expect(plist).toContain(TASKQ_LAUNCHD_LABEL);
    expect(plist).toContain('<integer>300</integer>');
    expect(plist).toContain('/ru/src/scripts/taskqDrain.ts');
  });
});
