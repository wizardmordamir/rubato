/**
 * Task Draft Forge — DB ops + the single-flight Ollama enhancement worker.
 *
 * Flow: a rough `task_draft` is saved with `enhance_state='queued'`. The worker
 * picks ONE queued draft at a time, sends `{system: pending_prompt, user: raw +
 * current best spec}` to the local Ollama (rubato's configured LLM), and appends
 * the result as a new `enhanced_tasks` revision. The original `raw_content` is
 * never touched. When a draft's `target_status` is `ready`, the fresh revision is
 * auto-published into the taskq queue via `addTask`.
 *
 * Single-flight (one draft at a time) is enforced here, server-side, by a module
 * guard — independent of the UI, so rapid saves queue instead of hammering Ollama.
 */

import { addTask, type NewTask } from 'cwip/taskq';
import { completeText } from '../api/llm/complete';
import { llmFromConfig } from '../api/llm/fromConfig';
import type { LlmMessage } from '../api/llm/types';
import { CODE_GROUNDING_RULES } from '../lib/ai/prompt';
import { loadConfig } from '../lib/config';
import type {
  DraftDetail,
  EnhancedTask,
  ForgeDraft,
  ForgeDraftInput,
  ForgeDraftPatch,
  ForgePrompt,
  ForgePromptInput,
  ForgeTargetStatus,
} from '../shared/forge';
import { DEFAULT_FORGE_PROMPT, getDb } from './db';
import { getTaskqDb } from './taskqDb';

const now = (): string => new Date().toISOString();

// ── Row mappers (SQLite stores booleans as 0/1) ──────────────────────────────

interface DraftRow {
  id: number;
  title: string;
  raw_content: string;
  target_status: string;
  enhance_state: string;
  pending_prompt: string | null;
  pending_prompt_id: number | null;
  current_enhanced_id: number | null;
  published_task_id: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toDraft(r: DraftRow): ForgeDraft {
  return {
    id: r.id,
    title: r.title,
    raw_content: r.raw_content,
    target_status: r.target_status as ForgeTargetStatus,
    enhance_state: r.enhance_state as ForgeDraft['enhance_state'],
    current_enhanced_id: r.current_enhanced_id,
    published_task_id: r.published_task_id,
    last_error: r.last_error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

interface EnhancedRow {
  id: number;
  draft_id: number;
  iteration: number;
  ai_specification: string;
  status: string;
  model_used: string | null;
  prompt_used: string;
  prompt_id: number | null;
  created_at: string;
}

function toEnhanced(r: EnhancedRow): EnhancedTask {
  return { ...r, status: r.status as ForgeTargetStatus };
}

interface PromptRow {
  id: number;
  name: string;
  body: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

function toPrompt(r: PromptRow): ForgePrompt {
  return { ...r, is_default: r.is_default === 1 };
}

// ── Prompts CRUD ─────────────────────────────────────────────────────────────

export function listPrompts(): ForgePrompt[] {
  return (getDb().query(`SELECT * FROM forge_prompts ORDER BY is_default DESC, name ASC`).all() as PromptRow[]).map(
    toPrompt,
  );
}

export function getPrompt(id: number): ForgePrompt | null {
  const r = getDb().query(`SELECT * FROM forge_prompts WHERE id = ?`).get(id) as PromptRow | undefined | null;
  return r ? toPrompt(r) : null;
}

/** The default prompt body (the one flagged `is_default`, else the seeded constant). */
export function defaultPromptBody(): string {
  const r = getDb().query(`SELECT body FROM forge_prompts WHERE is_default = 1 ORDER BY id ASC LIMIT 1`).get() as
    | { body: string }
    | undefined
    | null;
  return r?.body ?? DEFAULT_FORGE_PROMPT;
}

export function createPrompt(input: ForgePromptInput): ForgePrompt {
  const ts = now();
  const db = getDb();
  if (input.is_default) db.run(`UPDATE forge_prompts SET is_default = 0`);
  const res = db.run(
    `INSERT INTO forge_prompts (name, body, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [input.name.trim(), input.body, input.is_default ? 1 : 0, ts, ts],
  );
  return getPrompt(Number(res.lastInsertRowid)) as ForgePrompt;
}

export function updatePrompt(id: number, patch: ForgePromptInput): ForgePrompt | null {
  const existing = getPrompt(id);
  if (!existing) return null;
  const db = getDb();
  if (patch.is_default) db.run(`UPDATE forge_prompts SET is_default = 0`);
  db.run(`UPDATE forge_prompts SET name = ?, body = ?, is_default = ?, updated_at = ? WHERE id = ?`, [
    (patch.name ?? existing.name).trim(),
    patch.body ?? existing.body,
    patch.is_default ? 1 : 0,
    now(),
    id,
  ]);
  return getPrompt(id);
}

export function deletePrompt(id: number): boolean {
  // Never leave zero defaults: refuse to delete the last default prompt.
  const p = getPrompt(id);
  if (!p) return false;
  const db = getDb();
  const res = db.run(`DELETE FROM forge_prompts WHERE id = ?`, [id]);
  if (p.is_default) {
    const next = db.query(`SELECT id FROM forge_prompts ORDER BY id ASC LIMIT 1`).get() as { id: number } | undefined;
    if (next) db.run(`UPDATE forge_prompts SET is_default = 1 WHERE id = ?`, [next.id]);
  }
  return res.changes > 0;
}

// ── Drafts CRUD ──────────────────────────────────────────────────────────────

export function listDrafts(): ForgeDraft[] {
  return (getDb().query(`SELECT * FROM task_drafts ORDER BY updated_at DESC, id DESC`).all() as DraftRow[]).map(
    toDraft,
  );
}

export function getDraft(id: number): ForgeDraft | null {
  const r = getDb().query(`SELECT * FROM task_drafts WHERE id = ?`).get(id) as DraftRow | undefined | null;
  return r ? toDraft(r) : null;
}

export function getDraftDetail(id: number): DraftDetail | null {
  const draft = getDraft(id);
  if (!draft) return null;
  const revisions = (
    getDb().query(`SELECT * FROM enhanced_tasks WHERE draft_id = ? ORDER BY iteration DESC`).all(id) as EnhancedRow[]
  ).map(toEnhanced);
  return { draft, revisions };
}

/** Create a draft and immediately queue the first enhancement with the default prompt. */
export function createDraft(input: ForgeDraftInput): ForgeDraft {
  const ts = now();
  const res = getDb().run(
    `INSERT INTO task_drafts (title, raw_content, target_status, enhance_state, pending_prompt, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
    [input.title.trim(), input.raw_content ?? '', input.target_status ?? 'draft', defaultPromptBody(), ts, ts],
  );
  return getDraft(Number(res.lastInsertRowid)) as ForgeDraft;
}

/** Patch a draft's human fields (never the AI output). */
export function updateDraft(id: number, patch: ForgeDraftPatch): ForgeDraft | null {
  const existing = getDraft(id);
  if (!existing) return null;
  getDb().run(`UPDATE task_drafts SET title = ?, raw_content = ?, target_status = ?, updated_at = ? WHERE id = ?`, [
    (patch.title ?? existing.title).trim(),
    patch.raw_content ?? existing.raw_content,
    patch.target_status ?? existing.target_status,
    now(),
    id,
  ]);
  return getDraft(id);
}

/** Hand-edit an enhanced revision's spec text (editorial control before publish). */
export function updateRevision(id: number, aiSpecification: string): EnhancedTask | null {
  const db = getDb();
  const res = db.run(`UPDATE enhanced_tasks SET ai_specification = ? WHERE id = ?`, [aiSpecification, id]);
  if (res.changes === 0) return null;
  const r = db.query(`SELECT * FROM enhanced_tasks WHERE id = ?`).get(id) as EnhancedRow;
  return toEnhanced(r);
}

export function deleteDraft(id: number): boolean {
  const db = getDb();
  db.run(`DELETE FROM enhanced_tasks WHERE draft_id = ?`, [id]);
  return db.run(`DELETE FROM task_drafts WHERE id = ?`, [id]).changes > 0;
}

/** Queue another enhancement round. Prompt resolution: typed/edited text > saved
 *  prompt by id > the default prompt. Returns the updated draft, or null if gone. */
export function requestEnhance(id: number, req: { promptId?: number; promptText?: string }): ForgeDraft | null {
  if (!getDraft(id)) return null;
  let promptText = req.promptText?.trim();
  let promptId: number | null = null;
  if (!promptText && req.promptId != null) {
    const p = getPrompt(req.promptId);
    if (p) {
      promptText = p.body;
      promptId = p.id;
    }
  } else if (promptText && req.promptId != null) {
    // Edited a saved prompt: keep the linkage for display, use the edited text.
    promptId = req.promptId;
  }
  if (!promptText) promptText = defaultPromptBody();
  getDb().run(
    `UPDATE task_drafts SET enhance_state = 'queued', pending_prompt = ?, pending_prompt_id = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
    [promptText, promptId, now(), id],
  );
  return getDraft(id);
}

// ── Spec → taskq metadata ────────────────────────────────────────────────────

const MODELS = new Set(['opus', 'opus-1m', 'sonnet', 'haiku', 'fable']);
const THINKS = new Set(['off', 'low', 'medium', 'high', 'max']);

/** Parse the optional trailing `{"model":...,"think":...}` JSON line out of a spec,
 *  returning the cleaned body plus any valid model/think grade. */
export function parseSpecMeta(spec: string): { body: string; model?: string; think?: string } {
  const lines = spec.replace(/\s+$/, '').split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line) as { model?: string; think?: string };
      const model = obj.model && MODELS.has(obj.model) ? obj.model : undefined;
      const think = obj.think && THINKS.has(obj.think) ? obj.think : undefined;
      if (model || think) {
        const body = lines.slice(0, i).join('\n').replace(/\s+$/, '');
        return { body, model, think };
      }
    } catch {
      // not JSON — leave the spec untouched.
    }
    break;
  }
  return { body: spec.replace(/\s+$/, '') };
}

/** Best-effort repo inference from the draft title (ca/ru shorthand → repo name). */
function inferRepo(title: string): string | undefined {
  const t = ` ${title.toLowerCase()} `;
  if (/\b(ca|cursedalchemy)\b/.test(t)) return 'cursedalchemy';
  if (/\b(ru|rubato)\b/.test(t)) return 'rubato';
  if (/\bcwip\b/.test(t)) return 'cwip';
  return undefined;
}

/** How a finished spec becomes a taskq task. Injectable for tests. */
export type PublishFn = (task: NewTask) => number;
const defaultPublish: PublishFn = (task) => addTask(getTaskqDb(), task, { at: 'bottom' });

/** Publish a draft's current revision into the taskq queue (idempotent). Returns
 *  the updated draft, or null if the draft/revision is missing. */
export function publishDraft(id: number, publish: PublishFn = defaultPublish): ForgeDraft | null {
  const draft = getDraft(id);
  if (!draft) return null;
  if (draft.published_task_id != null) return draft; // already published — no-op.
  if (draft.current_enhanced_id == null) return draft; // nothing to publish yet.
  const rev = getDb().query(`SELECT * FROM enhanced_tasks WHERE id = ?`).get(draft.current_enhanced_id) as
    | EnhancedRow
    | undefined
    | null;
  if (!rev) return draft;
  const { body, model, think } = parseSpecMeta(rev.ai_specification);
  const taskId = publish({
    title: draft.title,
    body,
    status: 'ready',
    model,
    think,
    repo: inferRepo(draft.title),
  });
  getDb().run(`UPDATE task_drafts SET published_task_id = ?, updated_at = ? WHERE id = ?`, [taskId, now(), id]);
  return getDraft(id);
}

// ── The single-flight enhancement worker ─────────────────────────────────────

/** Drives one LLM round: system prompt + user content → spec text (+ model used). */
export type CompleteFn = (messages: LlmMessage[]) => Promise<{ text: string; model: string | null }>;

const defaultComplete: CompleteFn = async (messages) => {
  const provider = await llmFromConfig();
  const text = await completeText(provider, messages);
  const model = (await loadConfig()).ai?.direct?.model ?? null;
  return { text, model };
};

export interface EnhanceResult {
  draftId: number;
  ok: boolean;
  iteration?: number;
  error?: string;
}

/** Process the single oldest queued draft. Returns null when none are queued.
 *  Errors are caught and stored on the draft (state → 'error'); the worker moves on. */
export async function enhanceOnce(
  deps: { complete?: CompleteFn; publish?: PublishFn } = {},
): Promise<EnhanceResult | null> {
  const db = getDb();
  const row = db
    .query(`SELECT * FROM task_drafts WHERE enhance_state = 'queued' ORDER BY updated_at ASC, id ASC LIMIT 1`)
    .get() as DraftRow | undefined | null;
  if (!row) return null;

  db.run(`UPDATE task_drafts SET enhance_state = 'processing', updated_at = ? WHERE id = ?`, [now(), row.id]);

  // Inherit the same anti-hallucination guidance the chat uses, so draft→spec
  // rewrites that contain code/commands don't bake in JSON-assuming or
  // await-on-callback patterns. Opt-out via the global codeGrounding flag.
  const grounding = (await loadConfig()).ai?.codeGrounding ?? true;
  const basePrompt = row.pending_prompt ?? defaultPromptBody();
  const system = grounding ? `${basePrompt}${CODE_GROUNDING_RULES}` : basePrompt;
  const prev = row.current_enhanced_id
    ? (db.query(`SELECT ai_specification FROM enhanced_tasks WHERE id = ?`).get(row.current_enhanced_id) as
        | { ai_specification: string }
        | undefined)
    : undefined;
  const userContent = prev
    ? `Original draft title: ${row.title}\n\nOriginal draft:\n${row.raw_content}\n\nCurrent specification (revise and improve this):\n${prev.ai_specification}`
    : `Task title: ${row.title}\n\nRough draft:\n${row.raw_content}`;
  const messages: LlmMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];

  try {
    const complete = deps.complete ?? defaultComplete;
    const { text, model } = await complete(messages);
    if (!text.trim()) throw new Error('Ollama returned an empty response');

    const prevIter = (
      db.query(`SELECT MAX(iteration) AS m FROM enhanced_tasks WHERE draft_id = ?`).get(row.id) as {
        m: number | null;
      }
    ).m;
    const iteration = (prevIter ?? 0) + 1;
    const res = db.run(
      `INSERT INTO enhanced_tasks (draft_id, iteration, ai_specification, status, model_used, prompt_used, prompt_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, iteration, text.trim(), row.target_status, model, system, row.pending_prompt_id, now()],
    );
    const enhancedId = Number(res.lastInsertRowid);
    db.run(
      `UPDATE task_drafts SET enhance_state = 'idle', current_enhanced_id = ?, pending_prompt = NULL, pending_prompt_id = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
      [enhancedId, now(), row.id],
    );

    // Auto-publish only when the target is 'ready' and not already published.
    if (row.target_status === 'ready' && row.published_task_id == null) {
      publishDraft(row.id, deps.publish ?? defaultPublish);
    }
    return { draftId: row.id, ok: true, iteration };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    db.run(`UPDATE task_drafts SET enhance_state = 'error', last_error = ?, updated_at = ? WHERE id = ?`, [
      error,
      now(),
      row.id,
    ]);
    return { draftId: row.id, ok: false, error };
  }
}

/** Drain every queued draft, one at a time (sequential — never concurrent). */
export async function drainForgeQueue(deps: { complete?: CompleteFn; publish?: PublishFn } = {}): Promise<number> {
  let n = 0;
  while ((await enhanceOnce(deps)) !== null) n++;
  return n;
}

let processing = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** Run a drain pass unless one is already in flight (module-level single-flight). */
async function tick(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    await drainForgeQueue();
  } catch (e) {
    console.error('[forge] worker tick failed:', e);
  } finally {
    processing = false;
  }
}

/** Start the background worker: a periodic sweep plus an immediate first pass.
 *  Idempotent — calling twice keeps a single interval. */
export function startForgeWorker(intervalMs = 3000): void {
  if (timer) return;
  timer = setInterval(() => void tick(), intervalMs);
  void tick();
}

/** Best-effort nudge to process the queue now (after a create/enhance request). */
export function kickForgeWorker(): void {
  void tick();
}
