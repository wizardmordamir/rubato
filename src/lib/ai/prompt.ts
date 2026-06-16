/**
 * Assemble retrieved chunks + the question into provider-agnostic chat messages,
 * packing context greedily under a token budget. Returns the messages plus the
 * chunks actually used (so the worker can persist them as the answer's sources).
 *
 * Three shapes: an app-scoped prompt grounded in retrieved code (`buildPrompt`),
 * the same plus user-attached files, and a general prompt with no repo context
 * (`buildGeneralPrompt`) for ungrounded questions.
 */

import type { LlmMessage } from '../../api/llm/types';
import type { AskAttachment } from '../../shared/types';
import { estimateTokens } from './tokens';
import type { RetrievedChunk } from './types';

export interface PromptOptions {
  /** Token budget for the assembled context block (default 6000). */
  maxContextTokens?: number;
  /** Files the user attached to the question, included as extra context. */
  attachments?: AskAttachment[];
  /** Prior conversation turns to replay (multi-turn memory), oldest-first. */
  history?: LlmMessage[];
}

/** Greedily keep chunks (best-first) until the token budget is reached. */
export function packContext(chunks: RetrievedChunk[], maxTokens: number): RetrievedChunk[] {
  const kept: RetrievedChunk[] = [];
  let used = 0;
  for (const c of chunks) {
    const cost = estimateTokens(c.text) + 16; // + header line
    if (kept.length > 0 && used + cost > maxTokens) break;
    kept.push(c);
    used += cost;
  }
  return kept;
}

/** Format attached files into a context block, truncating to a token budget. */
export function formatAttachments(attachments: AskAttachment[], maxTokens: number): { block: string; tokens: number } {
  const blocks: string[] = [];
  let used = 0;
  for (const a of attachments) {
    if (used >= maxTokens) break;
    const remaining = maxTokens - used;
    let text = a.content;
    let cost = estimateTokens(text) + 8;
    if (cost > remaining) {
      // Truncate this file to roughly the remaining budget (≈4 chars/token).
      text = `${text.slice(0, Math.max(0, (remaining - 8) * 4))}\n… (truncated)`;
      cost = remaining;
    }
    blocks.push(`// Attached file: ${a.name}\n${text}`);
    used += cost;
  }
  return { block: blocks.join('\n\n'), tokens: used };
}

export interface BuiltPrompt {
  messages: LlmMessage[];
  /** The chunks that fit the budget and were included as context. */
  used: RetrievedChunk[];
}

export function buildPrompt(
  appName: string,
  question: string,
  chunks: RetrievedChunk[],
  opts: PromptOptions = {},
): BuiltPrompt {
  const budget = opts.maxContextTokens ?? 6000;
  const attachments = opts.attachments ?? [];
  // Attached files are user-chosen, so give them up to half the budget first.
  const att = attachments.length ? formatAttachments(attachments, Math.floor(budget / 2)) : { block: '', tokens: 0 };
  const used = packContext(chunks, budget - att.tokens);
  const context = used.map((c) => `// ${c.relativePath}:${c.startLine}-${c.endLine}\n${c.text}`).join('\n\n');

  // When retrieval (and any attachments) turned up nothing, don't push the model
  // toward refusing — much of what an app's chat is asked is general, not specific
  // to that app's code. Tell it to answer those from its own knowledge, and only
  // flag the missing index when the question genuinely needs this app's code.
  const hasContext = used.length > 0 || att.block.length > 0;
  const system = hasContext
    ? `You are a coding assistant answering questions about the app "${appName}". ` +
      `Use the provided context${attachments.length ? ' and attached files' : ''} to answer. ` +
      'Cite the file path and line range (e.g. src/foo.ts:10-20) for facts you rely on. ' +
      'If the context does not contain the answer, say so plainly rather than guessing.'
    : `You are a helpful assistant answering from the chat for the app "${appName}", but no ` +
      'indexed code context was found for this question. If the question is general (not specific ' +
      "to this app's own code), answer it directly and accurately from your own knowledge. If it " +
      "does depend on this app's code, note that the app isn't indexed for this question yet and " +
      'answer as best you can, flagging uncertainty rather than guessing.';

  const sections: string[] = [];
  if (att.block) sections.push(`Attached files:\n\n${att.block}`);
  if (used.length) sections.push(`Context from the codebase:\n\n${context}`);
  const body = sections.join('\n\n---\n\n');
  const user = body ? `${body}\n\n---\n\nQuestion: ${question}` : `Question: ${question}`;

  return {
    messages: [{ role: 'system', content: system }, ...(opts.history ?? []), { role: 'user', content: user }],
    used,
  };
}

/**
 * A general (no-repo) prompt: no retrieval, just the question plus any attached
 * files. Used when the user asks without selecting an app.
 */
export function buildGeneralPrompt(question: string, opts: PromptOptions = {}): BuiltPrompt {
  const budget = opts.maxContextTokens ?? 6000;
  const attachments = opts.attachments ?? [];
  const att = attachments.length ? formatAttachments(attachments, budget) : { block: '', tokens: 0 };

  const system =
    "You are a helpful assistant. Answer the user's question clearly and accurately" +
    (attachments.length ? ', using the attached files where relevant.' : '.');
  const user = att.block ? `Attached files:\n\n${att.block}\n\n---\n\nQuestion: ${question}` : question;

  return {
    messages: [{ role: 'system', content: system }, ...(opts.history ?? []), { role: 'user', content: user }],
    used: [],
  };
}
