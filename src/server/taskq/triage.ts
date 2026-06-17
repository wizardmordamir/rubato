/**
 * Opt-in triage + epic decomposition — the "intelligence" layer (off by default).
 *
 * Triage: a cheap agent grades each `pending_triage` task (blank model/think) and
 * assigns a model/think + a complexity. Single tasks become `ready`; epics are
 * decomposed by a planner into child tasks plus a `needs_input` gateway (the
 * no-stall user-input loop). Both LLM calls are injected, so the orchestration is
 * unit-tested with fakes; the real `claude -p` runners are in `triageAgents.ts`.
 */

import {
  addClarification,
  addTask,
  answerClarification,
  listChildren,
  listTasks,
  setStatus,
  type TaskqDb,
  type TaskRow,
  updateTask,
} from 'cwip/taskq';

export interface TriageVerdict {
  model?: string;
  think?: string;
  complexity: 'single' | 'epic';
}
export type TriageAgent = (task: TaskRow) => Promise<TriageVerdict>;

export interface EpicPlan {
  /** Ordered child steps the epic decomposes into. */
  children: { title: string; body?: string }[];
  /** The gateway question to ask the user before the children run. */
  question: string;
}
export type Planner = (task: TaskRow) => Promise<EpicPlan>;

export interface TriageSummary {
  graded: number;
  toReady: number;
  toEpic: number;
}

/**
 * Grade every `pending_triage` task: write its model/think + complexity. A
 * `single` task becomes `ready`; an `epic` stays `pending_triage` (complexity
 * stamped) for {@link runEpicDecomposition} to expand.
 */
export async function runTriage(db: TaskqDb, agent: TriageAgent, now: () => number = () => Date.now()): Promise<TriageSummary> {
  void now;
  const summary: TriageSummary = { graded: 0, toReady: 0, toEpic: 0 };
  for (const task of listTasks(db, { status: 'pending_triage' })) {
    const v = await agent(task);
    summary.graded++;
    updateTask(db, task.id, { model: v.model ?? task.model ?? undefined, think: v.think ?? task.think ?? undefined });
    db.run(`UPDATE tasks SET complexity = ? WHERE id = ?`, v.complexity, task.id);
    if (v.complexity === 'epic') {
      summary.toEpic++;
    } else {
      setStatus(db, task.id, 'ready');
      summary.toReady++;
    }
  }
  return summary;
}

export interface EpicSummary {
  decomposed: number;
  childrenCreated: number;
}

/**
 * Expand each `pending_triage` task graded `epic`: create its child steps
 * (`not_ready`, blocked behind the gateway) and park the epic itself as a
 * `needs_input` gateway with the planner's clarification question.
 */
export async function runEpicDecomposition(db: TaskqDb, planner: Planner, now: () => number = () => Date.now()): Promise<EpicSummary> {
  const summary: EpicSummary = { decomposed: 0, childrenCreated: 0 };
  const epics = listTasks(db, { status: 'pending_triage' }).filter((t) => t.complexity === 'epic');
  for (const epic of epics) {
    const plan = await planner(epic);
    for (const child of plan.children) {
      addTask(
        db,
        { title: child.title, body: child.body, status: 'not_ready', parent_id: epic.id, repo: epic.repo ?? undefined },
        { at: 'bottom' },
      );
      summary.childrenCreated++;
    }
    setStatus(db, epic.id, 'needs_input');
    addClarification(db, epic.id, plan.question, now());
    summary.decomposed++;
  }
  return summary;
}

/**
 * Resolve a gateway: record the answer, mark the epic done, and release its
 * `not_ready` children to `ready` (carrying the answer into their body so the
 * worker has the context).
 */
export function resolveGateway(db: TaskqDb, taskId: number, answer: string, now: () => number = () => Date.now()): void {
  answerClarification(db, taskId, answer, now());
  for (const child of listChildren(db, taskId)) {
    if (child.status === 'not_ready') {
      const body = child.body ? `${child.body}\n\n[gateway answer] ${answer}` : `[gateway answer] ${answer}`;
      updateTask(db, child.id, { body });
      setStatus(db, child.id, 'ready');
    }
  }
  setStatus(db, taskId, 'done');
}
