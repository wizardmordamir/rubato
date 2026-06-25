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

/**
 * Repos built CLEAN-ROOM (from scratch, fully isolated from any other codebase). Their workers
 * get a prompt that references ONLY the repo's own `/specs` — no mention of any other project,
 * no shared-lib/standards preamble, no integration-branch flow. A PreToolUse hook in the repo
 * additionally hard-blocks reading any outside code. Add a repo here to build it from scratch.
 */
const CLEAN_ROOM_REPOS = new Set(['nova']);

/** Clean-room worker prompt: build from this repo's /specs, uninfluenced by anything prior. */
function buildCleanRoomPrompt(task: TaskRow, markers: string): string {
  return [
    `You are a headless worker building this project from first principles. Do EXACTLY this one task, then stop.`,
    ``,
    `TASK #${task.id}${markers ? ` (${markers})` : ''}: ${task.title}`,
    task.body ? `\nDetails:\n${task.body}` : '',
    ``,
    `THIS PROJECT IS BUILT FROM SCRATCH. The ONLY source of truth is this repo's \`/specs\``,
    `(00-MASTER-PLAN, 01-REQUIREMENTS, 02-LESSONS, and the current phase's spec). There is`,
    `nothing else to look at, copy, or match — access outside this project is blocked. READ the`,
    `specs relevant to your task FIRST, then build the optimal thing they describe — fully`,
    `influenced by what the best way to build it is, and not at all by anything you've seen before.`,
    ``,
    `FIXED STACK: React + TypeScript (frontend), Bun + TypeScript (backend). Everything else is`,
    `chosen on merit per the specs and justified in writing. Do not pre-decide other dependencies`,
    `beyond what a task explicitly establishes.`,
    ``,
    `GIT WORKFLOW (single repo, local only):`,
    `- Do your work in a per-task git worktree branched from this repo's default branch; verify;`,
    `  then merge it back to the default branch with \`--ff-only\`. Resolve conflicts preserving`,
    `  both sides' intent and re-verify. Never land a broken default branch.`,
    `- VERIFY before done: the project builds, its tests pass, AND it ACTUALLY RUNS — boot it /`,
    `  render it headless (a green build alone is NOT enough; it can still fail at runtime).`,
    `- Local only, never push. Do not pick up any other task.`,
    ``,
    `DONE REQUIRES LANDED, WORKING CODE on the default branch — a real commit (non-empty git`,
    `delta), verified to build AND run. A "done" with nothing landed, or one that only makes the`,
    `build pass, is NOT done and will be reverted. Reference this task (#${task.id}) in the commit.`,
    ``,
    `If you hit a blocker you cannot resolve, explain why and stop (do not land partial work). A`,
    `transient failure is retried automatically — just explain what went wrong. ONLY if the task`,
    `is fundamentally impossible or needs a human decision you cannot supply, begin your final`,
    `reply with "${PERMANENT_FAILURE_MARKER}".`,
  ].join('\n');
}

/**
 * An "ask" task is a QUESTION the owner posed (e.g. from ca while away), not work to do —
 * marked by an `ASK` / `Q:` / `Question:` prefix on the title. The worker investigates and
 * ANSWERS read-only (changes nothing); its final reply IS the answer, surfaced back as the
 * task's completion summary. The bridge routes these to a full-access cwd + noop_ok so the
 * no-code answer isn't mistaken for a false-done.
 */
export function isQuestionTask(task: { title?: string | null }): boolean {
  return /^\s*(ask\b|q[:?]\s|question[:?\s])/i.test(task.title ?? '');
}

/** Read-only "answer the owner's question" prompt: full local access, investigate, change nothing. */
function buildAskPrompt(task: TaskRow, markers: string): string {
  return [
    `You are answering the owner's question while they are away. This is STRICTLY READ-ONLY:`,
    `investigate however you need, but do NOT modify, create, or delete any file, and do NOT`,
    `commit or change any state. Your FINAL REPLY *is* the answer the owner reads — make it the`,
    `clear, complete, honest answer a sharp senior engineer would give.`,
    ``,
    `QUESTION #${task.id}${markers ? ` (${markers})` : ''}: ${task.title}`,
    task.body ? `\n${task.body}` : '',
    ``,
    `You have full local access. Investigate the ACTUAL current state before answering — never`,
    `guess. Useful sources:`,
    `- the repos under /Users/curt/code/github (nova, cursedalchemy, rubato, cwip, cursedbelt):`,
    `  read code, \`git log\`/\`git status\`, recent commits.`,
    `- the orchestrator DB at ~/.taskq/taskq.sqlite via \`sqlite3\`: task status, what's running /`,
    `  done / failed, completion summaries (e.g. \`SELECT slug,status,repo FROM tasks ...\`).`,
    `- read-only commands (ls, git, sqlite3, grep) as needed.`,
    ``,
    `Answer directly and specifically — what's done, in progress, blocked, or failing, with`,
    `concrete evidence. If you couldn't determine something, say so honestly instead of inventing.`,
    `Keep it focused and readable. Change NOTHING — only answer.`,
  ].join('\n');
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
  if (isQuestionTask(task)) return buildAskPrompt(task, markers);
  if (task.repo && CLEAN_ROOM_REPOS.has(task.repo)) return buildCleanRoomPrompt(task, markers);
  return [
    `You are a headless taskq worker. Do EXACTLY this one task, then stop.`,
    ``,
    `TASK #${task.id}${markers ? ` (${markers})` : ''}: ${task.title}`,
    task.body ? `\nDetails:\n${task.body}` : '',
    ``,
    `ENGINEERING STANDARDS — read FIRST, before writing any code.`,
    `\`cursedbelt/STANDARDS.md\` is the ONE canonical source of truth for this refactor's`,
    `architecture + conventions (each repo's CLAUDE.md / README links it). Read it, then:`,
    `- REUSE, never duplicate. Prefer an existing \`cwip\` util or \`cursedbelt\` primitive`,
    `  over hand-rolling or copying a second version. If the right primitive is missing,`,
    `  ADD it to \`cwip\`/\`cursedbelt\` (one source of truth per concern) — not a local copy.`,
    `- Non-business code used by both apps belongs in \`cwip\` (framework-agnostic utils) or`,
    `  \`cursedbelt\` (UI/server primitives + theme), never re-implemented per app. Follow`,
    `  the placement + layering rules there, and the Biome / no-raw-overflow / no-raw-inputs`,
    `  / no-hardcoded-colors / ctgr + getOnly invariants STANDARDS.md spells out.`,
    `- Optimize, don't accumulate tech debt: leave the area in its most standard, deduped`,
    `  shape — retrofit stragglers onto the shared primitive rather than matching old code.`,
    ``,
    `INTEGRATION FLOW — read the target repo's CLAUDE.md "Git workflow" for the exact`,
    `commands, but the policy is:`,
    `- Branch your task worktree FROM \`refactor/integration\` (the integration base),`,
    `  not from main/master. If the repo has no \`refactor/integration\` branch, fall`,
    `  back to its default branch.`,
    `- First-party deps (cwip, cursedbelt) are SYMLINKED — never \`bun link\`-copy them.`,
    `  Run \`bun run setup\` then \`bun run relink\` in a fresh worktree; never "fix" a`,
    `  missing first-party export by downgrading code.`,
    `- Verify YOUR OWN repo/scope (scoped gate: tsc + lint + tests, plus ft/e2e only if`,
    `  you touched that layer). ALWAYS confirm your repo still builds (\`bun run build\`)`,
    `  before marking done.`,
    `- UI-TOUCHING tasks (changed anything under \`ui/\`, a page/component, the vite config,`,
    `  or a first-party dep its bundle pulls in): tsc + a green build are NOT enough — they`,
    `  pass even when the app WHITE-SCREENS at runtime (a React-dedupe gap → null hook`,
    `  dispatcher, a mount throw). After \`bun run build\`, RUN the render smoke and confirm`,
    `  GREEN before done: \`bun run src/scripts/renderSmoke.ts\` (a.k.a. \`rubato-render-smoke\`)`,
    `  boots the built UI headless and asserts the React root mounts with no fatal console/`,
    `  page errors. RED means it white-screens — fix it, do not mark done. (INCONCLUSIVE —`,
    `  no browser available — is neither a pass nor a hard block; note it; the promotion gate`,
    `  re-runs the render smoke as the backstop.)`,
    `- Merge your branch BACK into \`refactor/integration\` — NEVER into main/master.`,
    `  main is PROMOTION-ONLY: a recurring cross-repo gate fast-forwards main to`,
    `  integration once the whole system is green, so the owner's localhost (main)`,
    `  always works. Do not merge to or commit on main yourself.`,
    `- Cross-repo or whole-SYSTEM breakage on integration is TOLERATED — a later heal`,
    `  task fixes it. Complete your task as long as your own change is correct and`,
    `  introduces no unexpected NEW breakage in your own repo (a temporarily-red system`,
    `  build caused by an unrelated repo is fine; do not chase it).`,
    `- Local only, never push. Do not pick up any other task.`,
    ``,
    `DONE REQUIRES LANDED CODE. A reported "done" is auto-verified: the orchestrator checks`,
    `you actually landed commit(s) on \`refactor/integration\` (a non-empty git delta) and did`,
    `not regress its build. A "done" with no landed code — or one that turns a green integration`,
    `red — is REVERTED to a hold and alerted, NOT marked done. So never report success unless`,
    `you merged real work into \`refactor/integration\`; reference this task (#${task.id}) in the`,
    `commit/merge message so the landing is attributable. If there is genuinely nothing to land,`,
    `say so explicitly rather than claiming success.`,
    ``,
    `If you hit a blocker you cannot resolve, explain why and stop (do not land partial work).`,
    `A transient failure (a flaky service, a download that won't resolve) is retried`,
    `automatically — just explain what went wrong. ONLY if the task is fundamentally`,
    `impossible or needs a human decision/credential you cannot supply, begin your final`,
    `reply with "${PERMANENT_FAILURE_MARKER}" so the orchestrator parks it for a human`,
    `instead of wasting automatic retries.`,
  ].join('\n');
}

/**
 * The marker a worker prefixes its final reply with to signal a NON-retryable
 * failure (impossible / needs a human). Explicit + low-false-positive: the
 * orchestrator skips auto-retry only when the agent deliberately emits it. A
 * truly-stuck task with no marker still parks terminal once attempts run out.
 */
export const PERMANENT_FAILURE_MARKER = 'TASKQ-PERMANENT:';

/** True when a result string declares itself a permanent (non-retryable) failure. */
export function isPermanentFailureMessage(s: string | null | undefined): boolean {
  return !!s && s.toLowerCase().includes(PERMANENT_FAILURE_MARKER.toLowerCase());
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

/**
 * Recognise a genuine Max-plan / API usage-or-rate-limit failure in a result
 * string, as opposed to any other task failure. Used to distinguish "we really
 * are out of tokens" (respect the limit) from "the call went through fine, the
 * task just didn't finish" (proof we are NOT out → recalibrate the estimate).
 */
export function isUsageLimitMessage(s: string | null | undefined): boolean {
  if (!s) return false;
  const t = s.toLowerCase();
  return (
    t.includes('usage limit') ||
    t.includes('rate limit') ||
    t.includes('rate_limit') ||
    t.includes('limit reached') ||
    t.includes('too many requests') ||
    t.includes('quota') ||
    t.includes('overloaded') ||
    t.includes('exceeded your') ||
    /\b429\b/.test(t)
  );
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
  if (!env) {
    // Unparseable output is still telling: if the raw text shouts a usage limit,
    // classify it so the estimate can react instead of guessing.
    return {
      ok: false,
      reason: 'could not parse claude -p JSON result',
      rateLimited: isUsageLimitMessage(stdout),
    };
  }
  const ok = env.subtype === 'success' && !env.is_error;
  // Full result preserved for the AI summary stored in completions.
  const full = (env.result ?? '').trim();
  // Brief (collapsed, truncated) used only for failure reason notes and the rate-limit check.
  const brief = full.replace(/\s+/g, ' ').slice(0, 280);
  return {
    ok,
    summary: full || undefined,
    reason: ok ? undefined : brief || env.subtype || 'run did not succeed',
    outputTokens: env.usage?.output_tokens,
    rateLimited: !ok && isUsageLimitMessage(`${brief} ${env.subtype ?? ''}`),
    // The worker can declare the failure non-retryable (impossible / needs human).
    permanent: !ok && isPermanentFailureMessage(full),
  };
}

/** The outcome of one spawned agent run. */
export interface SpawnResult {
  exitCode: number;
  stdout: string;
  /** Captured stderr (an agent's usage-limit / crash detail often lands here). */
  stderr?: string;
  /** True when the run was killed for exceeding {@link SpawnOpts.timeoutMs}. */
  timedOut?: boolean;
}

/** Per-spawn options (a hard timeout is the only knob today). */
export interface SpawnOpts {
  /** Kill the process after this many ms (0 / omitted ⇒ no timeout). */
  timeoutMs?: number;
}

export type SpawnFn = (
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  opts?: SpawnOpts,
) => Promise<SpawnResult>;

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
    const { exitCode, stdout, stderr, timedOut } = await spawn(cmd, cwd, env, { timeoutMs: config.taskTimeoutMs });
    if (timedOut)
      return {
        ok: false,
        reason: `claude -p timed out after ${Math.round(config.taskTimeoutMs / 60_000)}m and was killed`,
        // A hang is not a usage-limit signal — don't let it skew the estimate.
        rateLimited: false,
      };
    if (exitCode !== 0)
      // Scan BOTH streams: a non-zero exit usually prints the reason to stderr,
      // and a usage-limit error there must still be classified as rate-limited.
      return {
        ok: false,
        reason: `claude -p exited ${exitCode}`,
        rateLimited: isUsageLimitMessage(`${stdout}\n${stderr ?? ''}`),
      };
    return parseClaudeResult(stdout);
  };
}

/**
 * Default spawn: run the command with the agent PATH, capturing stdout AND
 * stderr. A hard `timeoutMs` kills a hung run (SIGTERM, then SIGKILL after a
 * grace period) so a stuck agent can never wedge the drain. stderr is still
 * forwarded to our own stderr afterward so the watchdog log keeps showing it.
 */
const defaultSpawn: SpawnFn = async (cmd, cwd, env, opts) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  const timeoutMs = opts?.timeoutMs ?? 0;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            proc.kill(); // SIGTERM
          } catch {}
          // Escalate to SIGKILL if it ignores the polite signal.
          killTimer = setTimeout(() => {
            try {
              proc.kill(9);
            } catch {}
          }, 10_000);
        }, timeoutMs)
      : undefined;
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    if (stderr) process.stderr.write(stderr);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }
};

/** What a capacity probe learned about the account's true limit state. */
export interface CapacityProbe {
  /** True only when a genuine usage-limit error came back (we really are out). */
  rateLimited: boolean;
  /** True when the probe call completed without a usage-limit error. */
  ok: boolean;
  /** Raw detail for logs. */
  detail: string;
}

/**
 * Fire ONE trivial `claude -p` call (cheapest model) purely to learn whether the
 * subscription is actually out of tokens — the only authoritative signal for the
 * Max-plan session/weekly limits, which the API headers don't expose. Used to
 * self-heal a stuck "0% remaining" reading when there's no real task to ride on
 * (empty queue, or a user-triggered re-check). Never throws.
 */
export async function probeClaudeCapacity(spawn: SpawnFn = defaultSpawn): Promise<CapacityProbe> {
  try {
    const cmd = [
      'claude',
      '-p',
      'Reply with exactly: ok',
      '--model',
      MODEL_IDS.haiku,
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
    ];
    // A trivial probe should return in seconds — cap it so a hung CLI can't
    // wedge the empty-queue self-heal path.
    const { exitCode, stdout, stderr, timedOut } = await spawn(
      cmd,
      process.cwd(),
      { PATH: agentPath() },
      {
        timeoutMs: 120_000,
      },
    );
    if (timedOut) return { rateLimited: false, ok: false, detail: 'probe timed out' };
    const rateLimited = isUsageLimitMessage(`${stdout}\n${stderr ?? ''}`);
    if (rateLimited) return { rateLimited: true, ok: false, detail: 'usage-limit error on probe' };
    if (exitCode !== 0) return { rateLimited: false, ok: false, detail: `probe exited ${exitCode}` };
    const res = parseClaudeResult(stdout);
    return { rateLimited: !!res.rateLimited, ok: res.ok, detail: res.summary ?? res.reason ?? 'probe completed' };
  } catch (e) {
    // A spawn/exec failure tells us nothing about capacity — report inconclusive.
    return { rateLimited: false, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** A no-op executor for dry-run validation — logs + reports success, no agent. */
export const dryRunExecutor: TaskExecutor = async (task, ctx) => {
  process.stdout.write(`[dry-run] worker ${ctx.index} would run #${task.id}: ${task.title}\n`);
  return { ok: true, summary: 'dry-run (no agent spawned)' };
};
