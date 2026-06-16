/**
 * Self-ask retrieval planner (pure). Between retrieval rounds the worker asks
 * the LLM whether the snippets gathered so far can fully answer the question,
 * and if not, what to search next. Kept provider-agnostic: the model replies in
 * plain JSON (no function-calling), parsed defensively here. The LLM round-trip
 * itself lives in the worker; this module only builds the prompt and reads the
 * verdict, so both halves are unit-testable.
 */

import type { LlmMessage } from '../../api/llm/types';
import type { RetrievedChunk } from './types';

export interface RetrievalDecision {
  /** True when the gathered context is enough to fully answer. */
  sufficient: boolean;
  /** Up to a few NEW search queries to try when not sufficient. */
  queries: string[];
}

/** Max follow-up queries honored from one decision (keeps fan-out bounded). */
const MAX_QUERIES = 3;
/** Cap the inventory so the planner prompt stays cheap on big contexts. */
const MAX_INVENTORY = 40;
const PREVIEW_CHARS = 100;

/** Build the planner messages: the question + an inventory of what's retrieved. */
export function buildPlannerPrompt(question: string, gathered: RetrievedChunk[]): LlmMessage[] {
  const inventory = gathered
    .slice(0, MAX_INVENTORY)
    .map((c) => {
      const preview = c.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
      return `- ${c.relativePath}:${c.startLine}-${c.endLine} — ${preview}`;
    })
    .join('\n');

  const system =
    'You plan retrieval for a codebase Q&A system. Given a question and the code ' +
    'snippets gathered so far, decide whether they are SUFFICIENT to fully and ' +
    'accurately answer — for counting/enumeration questions, that means the ' +
    'relevant file(s) appear complete, not partial. If not sufficient, propose up ' +
    `to ${MAX_QUERIES} NEW short keyword search queries (file names, symbols, route ` +
    "paths) likely to surface what's missing. Reply with ONLY a JSON object: " +
    '{"sufficient": boolean, "queries": string[]}. No prose, no code fences.';

  const user = `Question: ${question}\n\nRetrieved so far:\n${inventory || '(nothing yet)'}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Parse the planner's reply. Defensive: extracts the first JSON object and
 * defaults to `sufficient: true` (stop the loop) on anything unparseable, so a
 * chatty or malformed model can never spin the loop or inject junk queries.
 */
export function parseDecision(reply: string): RetrievalDecision {
  const stop: RetrievalDecision = { sufficient: true, queries: [] };
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return stop;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return stop;
  }
  if (typeof raw !== 'object' || raw === null) return stop;
  const obj = raw as Record<string, unknown>;
  const queries = Array.isArray(obj.queries)
    ? obj.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, MAX_QUERIES)
    : [];
  // Only treat as "need more" when the model explicitly says so AND offers queries.
  const sufficient = !(obj.sufficient === false && queries.length > 0);
  return { sufficient, queries };
}
