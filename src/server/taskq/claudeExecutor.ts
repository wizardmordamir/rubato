/**
 * The real worker executor: spawn a headless `claude -p` agent to do one task,
 * then parse its result. Mirrors the old drainer's per-task worker launch, but
 * delegates worktree creation to the agent's own CLAUDE.md workflow (as an
 * interactive session would) rather than pre-provisioning it.
 *
 * Side-effectful (spawns Claude, mutates repos) — kept thin + injected into the
 * pure {@link runDrain} loop, which is what the unit tests exercise.
 */

import type { TaskRow } from 'cwip/taskq';
import { type TaskqConfig, repoRoot } from './config';
import type { TaskExecutor, TaskResult } from './orchestrator';

/** Map a task's `model` alias to a full `claude -p --model` id. */
const MODEL_IDS: Record<string, string> = {
  opus: 'claude-opus-4-8',
  'opus-1m': 'claude-opus-4-8[1m]',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5',
};

const THINK_TOKENS: Record<string, number> = { off: 0, low: 4000, medium: 12000, high: 24000, max: 63999 };

/** The instruction prompt handed to the worker agent for one task. */
export function buildWorkerPrompt(task: TaskRow): string {
  const markers = [
    task.slug && `id: ${task.slug}`,
    task.group_key && `group: ${task.group_key}`,
    task.repo && `repo: ${task.repo}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return [
    `You are a headless taskq worker. Do EXACTLY this one task, then stop.`,
    ``,
    `TASK #${task.id}${markers ? ` (${markers})` : ''}: ${task.title}`,
    task.body ? `\nDetails:\n${task.body}` : '',
    ``,
    `Follow the target repo's CLAUDE.md workflow (worktree, scoped verify gate, commit,`,
    `merge to the default branch — local only, never push). Do not pick up any other task.`,
    ``,
    `When finished, print a SINGLE final line of JSON and nothing after it:`,
    `{"ok": true, "commit": "<short sha or empty>", "summary": "<one line>"}`,
    `or, if you could not complete it: {"ok": false, "reason": "<why>"}`,
  ].join('\n');
}

/** Pull the worker's trailing `{"ok":…}` result line out of its stdout. */
export function parseWorkerResult(stdout: string): TaskResult {
  const lines = stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{') && lines[i].includes('"ok"')) {
      try {
        const parsed = JSON.parse(lines[i]) as TaskResult;
        if (typeof parsed.ok === 'boolean') return parsed;
      } catch {
        // keep scanning upward
      }
    }
  }
  return { ok: false, reason: 'worker produced no result line' };
}

/**
 * Build a {@link TaskExecutor} that runs each task via `claude -p`. `spawn` is
 * injectable (defaults to Bun's) so this is testable without a real Claude.
 */
export type SpawnFn = (
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string }>;

export function makeClaudeExecutor(config: TaskqConfig, spawn: SpawnFn = defaultSpawn): TaskExecutor {
  return async (task: TaskRow): Promise<TaskResult> => {
    const cwd = repoRoot(config, task.repo) ?? process.cwd();
    const model = MODEL_IDS[task.model ?? config.model] ?? MODEL_IDS[config.model];
    const cmd = ['claude', '-p', buildWorkerPrompt(task), '--dangerously-skip-permissions', '--model', model];
    const think = task.think ? THINK_TOKENS[task.think] : undefined;
    const env = think ? { MAX_THINKING_TOKENS: String(think) } : undefined;
    const { exitCode, stdout } = await spawn(cmd, cwd, env);
    if (exitCode !== 0) return { ok: false, reason: `claude -p exited ${exitCode}` };
    return parseWorkerResult(stdout);
  };
}

/** Default spawn: run the command, capture stdout, resolve with exit code. */
const defaultSpawn: SpawnFn = async (cmd, cwd, env) => {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'inherit',
    env: env ? { ...process.env, ...env } : process.env,
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
};

/** A no-op executor for dry-run validation — logs + reports success, no agent. */
export const dryRunExecutor: TaskExecutor = async (task, ctx) => {
  process.stdout.write(`[dry-run] worker ${ctx.index} would run #${task.id}: ${task.title}\n`);
  return { ok: true, summary: 'dry-run (no agent spawned)' };
};
