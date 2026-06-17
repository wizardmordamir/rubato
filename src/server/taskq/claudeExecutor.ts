/**
 * The real worker executor: spawn a headless `claude -p` agent to do one task,
 * then parse its result. Mirrors the old drainer's per-task worker launch
 * (`--output-format json --dangerously-skip-permissions`), but delegates worktree
 * creation to the agent's own CLAUDE.md workflow rather than pre-provisioning it.
 *
 * Side-effectful (spawns Claude, mutates repos) — kept thin + injected into the
 * pure {@link runDrain} loop, which is what the unit tests exercise.
 */

import { homedir } from 'node:os';
import type { TaskRow } from 'cwip/taskq';
import { repoRoot, type TaskqConfig } from './config';
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

/**
 * PATH for spawned agents — launchd starts the drainer with a minimal PATH, so
 * (like the old `drain-queue.sh`) we prepend the dirs that hold `claude` + `bun`.
 */
export function agentPath(): string {
  const home = homedir();
  const dirs = [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    '/opt/homebrew/bin',
    `${home}/.cargo/bin`,
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return `${dirs.join(':')}:${process.env.PATH ?? ''}`;
}

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
    `If you hit a blocker you cannot resolve, explain why and stop (do not land partial work).`,
  ].join('\n');
}

/** The `claude -p --output-format json` result envelope (the fields we use). */
interface ClaudeEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: { output_tokens?: number; input_tokens?: number };
}

/** Parse the `--output-format json` envelope into a {@link TaskResult}. */
export function parseClaudeResult(stdout: string): TaskResult {
  const trimmed = stdout.trim();
  let env: ClaudeEnvelope | null = null;
  try {
    env = JSON.parse(trimmed) as ClaudeEnvelope;
  } catch {
    // Some shells prepend noise — fall back to the last JSON-object line.
    const line = trimmed
      .split('\n')
      .reverse()
      .find((l) => l.trim().startsWith('{'));
    if (line) {
      try {
        env = JSON.parse(line) as ClaudeEnvelope;
      } catch {
        env = null;
      }
    }
  }
  if (!env) return { ok: false, reason: 'could not parse claude -p JSON result' };
  const ok = env.subtype === 'success' && !env.is_error;
  const summary = (env.result ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
  return {
    ok,
    summary: summary || undefined,
    reason: ok ? undefined : summary || env.subtype || 'run did not succeed',
    outputTokens: env.usage?.output_tokens,
  };
}

export type SpawnFn = (
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string }>;

export function makeClaudeExecutor(config: TaskqConfig, spawn: SpawnFn = defaultSpawn): TaskExecutor {
  return async (task: TaskRow): Promise<TaskResult> => {
    const cwd = repoRoot(config, task.repo) ?? process.cwd();
    const model = MODEL_IDS[task.model ?? config.model] ?? MODEL_IDS[config.model];
    const cmd = [
      'claude',
      '-p',
      buildWorkerPrompt(task),
      '--model',
      model,
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
    ];
    const env: Record<string, string> = { PATH: agentPath() };
    // Task marker wins; else the config's default thinking level.
    const thinkLevel = task.think ?? config.think;
    const think = thinkLevel ? THINK_TOKENS[thinkLevel] : undefined;
    if (think) env.MAX_THINKING_TOKENS = String(think);
    const { exitCode, stdout } = await spawn(cmd, cwd, env);
    if (exitCode !== 0) return { ok: false, reason: `claude -p exited ${exitCode}` };
    return parseClaudeResult(stdout);
  };
}

/** Default spawn: run the command with the agent PATH, capture stdout. */
const defaultSpawn: SpawnFn = async (cmd, cwd, env) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'inherit', env: { ...process.env, ...env } });
  const stdout = await new Response(proc.stdout).text();
  return { exitCode: await proc.exited, stdout };
};

/** A no-op executor for dry-run validation — logs + reports success, no agent. */
export const dryRunExecutor: TaskExecutor = async (task, ctx) => {
  process.stdout.write(`[dry-run] worker ${ctx.index} would run #${task.id}: ${task.title}\n`);
  return { ok: true, summary: 'dry-run (no agent spawned)' };
};
