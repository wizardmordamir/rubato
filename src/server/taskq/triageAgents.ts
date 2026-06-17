/**
 * The real `claude -p` triage + planning agents (cheap model). Thin + injectable
 * spawn so the orchestration logic in `triage.ts` is tested with fakes. Off by
 * default; the drainer only invokes these when `config.triage.enabled`.
 */

import type { TaskRow } from 'cwip/taskq';
import type { EpicPlan, Planner, TriageAgent, TriageVerdict } from './triage';

const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';

type SpawnFn = (cmd: string[]) => Promise<{ exitCode: number; stdout: string }>;

const defaultSpawn: SpawnFn = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'inherit' });
  const stdout = await new Response(proc.stdout).text();
  return { exitCode: await proc.exited, stdout };
};

/** Pull the last `{...}` JSON object out of agent stdout. */
function lastJson<T>(stdout: string): T | null {
  const lines = stdout
    .trim()
    .split('\n')
    .map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{')) {
      try {
        return JSON.parse(lines[i]) as T;
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

export function makeTriageAgent(spawn: SpawnFn = defaultSpawn): TriageAgent {
  return async (task: TaskRow): Promise<TriageVerdict> => {
    const prompt = [
      `Grade this dev task for an autonomous coding queue. Reply with ONE line of JSON only:`,
      `{"model": "haiku|sonnet|opus", "think": "off|low|medium|high|max", "complexity": "single|epic"}`,
      `Pick the CHEAPEST model + thinking that fits (mechanical→haiku/off; normal→sonnet/low; hard design/debug→opus/high).`,
      `"epic" = a large multi-stage effort that should be broken into sub-tasks.`,
      ``,
      `TASK: ${task.title}`,
      task.body ? `DETAILS: ${task.body}` : '',
    ].join('\n');
    const { exitCode, stdout } = await spawn(['claude', '-p', prompt, '--model', TRIAGE_MODEL]);
    const v = exitCode === 0 ? lastJson<TriageVerdict>(stdout) : null;
    // Safe fallback: a normal single task on the default tier.
    return v && (v.complexity === 'single' || v.complexity === 'epic') ? v : { complexity: 'single' };
  };
}

export function makePlanner(spawn: SpawnFn = defaultSpawn): Planner {
  return async (task: TaskRow): Promise<EpicPlan> => {
    const prompt = [
      `Decompose this EPIC into an ordered list of discrete sub-tasks, and ONE clarifying`,
      `question to ask before work starts. Reply with ONE line of JSON only:`,
      `{"children": [{"title": "...", "body": "..."}], "question": "..."}`,
      ``,
      `EPIC: ${task.title}`,
      task.body ? `DETAILS: ${task.body}` : '',
    ].join('\n');
    const { exitCode, stdout } = await spawn(['claude', '-p', prompt, '--model', TRIAGE_MODEL]);
    const plan = exitCode === 0 ? lastJson<EpicPlan>(stdout) : null;
    if (plan && Array.isArray(plan.children) && plan.children.length && typeof plan.question === 'string') return plan;
    // Fallback: a single clarification, no children (keeps the gateway intact).
    return {
      children: [],
      question: `This looked large but couldn't be auto-planned. How should "${task.title}" be broken down?`,
    };
  };
}
