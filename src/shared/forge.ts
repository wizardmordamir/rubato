/**
 * Task Draft Forge — wire types shared by the rubato server and UI.
 *
 * A "draft" is a rough human task description. A background worker sends it to
 * the local Ollama (rubato's configured LLM) one at a time, which rewrites it
 * into a queue-ready spec stored as an `EnhancedTask` revision. The original
 * `raw_content` is never overwritten; each enhancement round appends a new
 * revision (so you can iterate). When a draft's `target_status` is `ready`, the
 * latest revision is auto-published into the taskq queue via `addTask`.
 */

/** Where the enhanced task is headed. `draft` = keep iterating with Ollama and
 *  never publish; `hold` = wait for a manual publish; `ready` = auto-publish to
 *  taskq once the next enhancement completes. */
export type ForgeTargetStatus = 'draft' | 'hold' | 'ready';
export const FORGE_TARGET_STATUSES: ForgeTargetStatus[] = ['draft', 'hold', 'ready'];

/** Lifecycle of a draft's enhancement work. */
export type ForgeEnhanceState = 'idle' | 'queued' | 'processing' | 'error';

/** The human source row — never overwritten by the AI. */
export interface ForgeDraft {
  id: number;
  title: string;
  raw_content: string;
  target_status: ForgeTargetStatus;
  enhance_state: ForgeEnhanceState;
  /** Latest `EnhancedTask` id (the current best spec), or null before the first run. */
  current_enhanced_id: number | null;
  /** taskq task id once published, or null. Guards against double-publish. */
  published_task_id: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** One enhancement iteration — the AI output (revision chain, one row per round). */
export interface EnhancedTask {
  id: number;
  draft_id: number;
  iteration: number;
  ai_specification: string;
  /** Snapshot of the draft's target_status when this revision was generated. */
  status: ForgeTargetStatus;
  model_used: string | null;
  /** The exact prompt text used for this round (default / saved / typed / edited). */
  prompt_used: string;
  /** Which saved prompt was used, if any. */
  prompt_id: number | null;
  created_at: string;
}

/** A saved, reusable refinement prompt. */
export interface ForgePrompt {
  id: number;
  name: string;
  body: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface ForgeDraftInput {
  title: string;
  raw_content: string;
  target_status?: ForgeTargetStatus;
}

export interface ForgeDraftPatch {
  title?: string;
  raw_content?: string;
  target_status?: ForgeTargetStatus;
}

/** Request another enhancement round. Prompt resolution: `promptText` (typed or
 *  edited) wins, else the saved prompt `promptId`, else the default prompt. */
export interface EnhanceRequest {
  promptId?: number;
  promptText?: string;
}

export interface ForgePromptInput {
  name: string;
  body: string;
  is_default?: boolean;
}

/** A draft plus its full revision chain (newest first) — the comparator payload. */
export interface DraftDetail {
  draft: ForgeDraft;
  revisions: EnhancedTask[];
}
