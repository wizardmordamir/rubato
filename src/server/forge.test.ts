import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { addTask, listTasks, migrate, type NewTask, type TaskqDb } from 'cwip/taskq';
import type { LlmMessage } from '../api/llm/types';
import { __resetDbForTests } from './db';
import {
  type CompleteFn,
  createDraft,
  drainForgeQueue,
  enhanceOnce,
  getDraftDetail,
  parseSpecMeta,
  publishDraft,
  type PublishFn,
  requestEnhance,
} from './forge';

// An in-memory taskq queue + a publisher that writes into it (no ~/.taskq touch).
function memQueue(): { db: TaskqDb; publish: PublishFn } {
  const db = new Database(':memory:') as unknown as TaskqDb;
  migrate(db);
  return { db, publish: (task: NewTask) => addTask(db, task, { at: 'bottom' }) };
}

// A fake LLM that echoes a deterministic spec; records concurrency.
function fakeComplete(opts: { active: { n: number; max: number }; reply?: (m: LlmMessage[]) => string } = { active: { n: 0, max: 0 } }): CompleteFn {
  return async (messages) => {
    opts.active.n++;
    opts.active.max = Math.max(opts.active.max, opts.active.n);
    await new Promise((r) => setTimeout(r, 5));
    opts.active.n--;
    const text = opts.reply ? opts.reply(messages) : `# Spec\n\n${messages[1].content}`;
    return { text, model: 'llama3' };
  };
}

describe('forge', () => {
  beforeEach(() => {
    __resetDbForTests();
  });

  test('parseSpecMeta strips a trailing grade JSON and extracts model/think', () => {
    const spec = '# Title\n\nBody text.\n{"model":"sonnet","think":"low"}';
    const r = parseSpecMeta(spec);
    expect(r.body).toBe('# Title\n\nBody text.');
    expect(r.model).toBe('sonnet');
    expect(r.think).toBe('low');
  });

  test('parseSpecMeta ignores invalid model/think and leaves the body intact', () => {
    const spec = '# Title\n\nBody.\n{"model":"gpt-9","think":"ultra"}';
    const r = parseSpecMeta(spec);
    expect(r.body).toBe(spec.replace(/\s+$/, ''));
    expect(r.model).toBeUndefined();
    expect(r.think).toBeUndefined();
  });

  test('creating a draft queues it and enhanceOnce produces iteration 1', async () => {
    const d = createDraft({ title: 'do a thing', raw_content: 'rough notes', target_status: 'draft' });
    expect(d.enhance_state).toBe('queued');

    const res = await enhanceOnce({ complete: fakeComplete() });
    expect(res).toEqual({ draftId: d.id, ok: true, iteration: 1 });

    const detail = getDraftDetail(d.id);
    expect(detail?.draft.enhance_state).toBe('idle');
    expect(detail?.revisions).toHaveLength(1);
    expect(detail?.revisions[0].iteration).toBe(1);
    expect(detail?.revisions[0].ai_specification).toContain('rough notes');
  });

  test('re-enhancing appends a second revision and refines the previous spec', async () => {
    const d = createDraft({ title: 't', raw_content: 'v1', target_status: 'draft' });
    await enhanceOnce({ complete: fakeComplete() });

    // Second round: the user content should include the prior spec to refine.
    let sawPrev = false;
    const complete: CompleteFn = async (messages) => {
      sawPrev = messages[1].content.includes('Current specification');
      return { text: 'refined spec', model: 'llama3' };
    };
    requestEnhance(d.id, { promptText: 'make it tighter' });
    const res = await enhanceOnce({ complete });
    expect(res?.iteration).toBe(2);
    expect(sawPrev).toBe(true);

    const detail = getDraftDetail(d.id);
    expect(detail?.revisions).toHaveLength(2);
    expect(detail?.draft.current_enhanced_id).toBe(detail?.revisions[0].id ?? -1); // newest first
  });

  test('the worker processes queued drafts one at a time (single-flight)', async () => {
    createDraft({ title: 'a', raw_content: 'a', target_status: 'draft' });
    createDraft({ title: 'b', raw_content: 'b', target_status: 'draft' });
    createDraft({ title: 'c', raw_content: 'c', target_status: 'draft' });

    const active = { n: 0, max: 0 };
    const count = await drainForgeQueue({ complete: fakeComplete({ active }) });
    expect(count).toBe(3);
    expect(active.max).toBe(1); // never two LLM calls at once
  });

  test('auto-publishes only when target is ready, and is idempotent', async () => {
    const { db, publish } = memQueue();

    const ready = createDraft({ title: 'ca ship it', raw_content: 'x', target_status: 'ready' });
    const held = createDraft({ title: 'hold this', raw_content: 'y', target_status: 'hold' });

    await drainForgeQueue({ complete: fakeComplete(), publish });

    const tasks = listTasks(db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('ca ship it');
    expect(tasks[0].repo).toBe('cursedalchemy'); // inferred from "ca"

    // The held draft is enhanced but NOT published.
    expect(getDraftDetail(held.id)?.draft.published_task_id).toBeNull();
    expect(getDraftDetail(ready.id)?.draft.published_task_id).not.toBeNull();

    // Re-publishing the ready draft is a no-op (no duplicate task).
    publishDraft(ready.id, publish);
    expect(listTasks(db)).toHaveLength(1);
  });

  test('an LLM error flags the draft and the worker keeps going', async () => {
    const bad = createDraft({ title: 'boom', raw_content: 'x', target_status: 'draft' });
    const good = createDraft({ title: 'ok', raw_content: 'y', target_status: 'draft' });

    // First queued draft (oldest = bad) throws; the next must still process.
    const complete: CompleteFn = async (messages) => {
      if (messages[1].content.includes('x')) throw new Error('ollama offline');
      return { text: 'fine', model: 'llama3' };
    };
    const count = await drainForgeQueue({ complete });
    expect(count).toBe(2); // both drafts were attempted

    expect(getDraftDetail(bad.id)?.draft.enhance_state).toBe('error');
    expect(getDraftDetail(bad.id)?.draft.last_error).toContain('ollama offline');
    expect(getDraftDetail(good.id)?.draft.enhance_state).toBe('idle');
  });

  test('prompt resolution: typed text wins over a saved prompt id', async () => {
    const d = createDraft({ title: 't', raw_content: 'r', target_status: 'draft' });
    // Drain the initial default-prompt round first.
    await enhanceOnce({ complete: fakeComplete() });

    requestEnhance(d.id, { promptText: 'MY CUSTOM PROMPT', promptId: 999 });
    let systemSeen = '';
    const complete: CompleteFn = async (messages) => {
      systemSeen = messages[0].content;
      return { text: 'ok', model: null };
    };
    await enhanceOnce({ complete });
    // Typed text wins over the saved id and forms the BASE system prompt; the
    // code-grounding rules (on by default) are appended after it.
    expect(systemSeen.startsWith('MY CUSTOM PROMPT')).toBe(true);
  });
});
