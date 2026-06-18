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
  /** Compact App Map (routes/endpoints/dirs) prepended to the system prompt for global awareness. */
  appMap?: string;
  /** `[Runtime Reference]` block (Bun version, app path, deps, tool versions) for code grounding. */
  runtimeRef?: string;
  /** When set, append the code-generation rules + few-shot anchors to the system prompt. */
  codeMode?: boolean;
  /** `[UI Vision Reference]` markdown diagnostic from the screenshot-extraction step. */
  visionRef?: string;
}

/**
 * Anti-hallucination rules + tiny golden few-shot anchors for code-shaped
 * questions. Targets the exact failure modes a local coder model was observed
 * producing (JSON-assuming, await-on-callback, wrong shapes, relative FS paths).
 * Kept small (~250 tokens) and only injected in code mode.
 */
export const CODE_GROUNDING_RULES =
  '\n\nCode-generation rules (follow exactly):\n' +
  '- Do NOT assume a CLI/tool outputs JSON unless the context shows it. If output format is unknown, write a robust string parser (split lines, extract fields) rather than calling JSON.parse on it.\n' +
  '- Use the exact request/response and data shapes shown in the context. If you need a type that is not in the context, declare it explicitly before using it — never invent fields on an existing type.\n' +
  '- Node `child_process.exec`/`execFile` are callback-style and return a ChildProcess, not a Promise. To await them use `util.promisify(exec)`, or prefer `Bun.$`/`Bun.spawn`. Never `await` a callback-style call directly.\n' +
  '- Anchor filesystem paths with `path.join(import.meta.dir, …)` (or `__dirname`), never bare relative strings, so they survive a different working directory.\n' +
  'Examples of the correct patterns:\n' +
  '```ts\n' +
  "import { promisify } from 'node:util';\n" +
  "import { exec } from 'node:child_process';\n" +
  'const execAsync = promisify(exec);\n' +
  "const { stdout } = await execAsync('git status');\n" +
  '```\n' +
  '```ts\n' +
  "import { join } from 'node:path';\n" +
  "const dataPath = join(import.meta.dir, '..', 'data', 'cache.json');\n" +
  '```';

/**
 * Heuristic: is this a code-shaped question (worth the runtime block + code rules)?
 * Cheap regex, no LLM call; a false positive only injects harmless extra guidance.
 */
export function isCodeQuestion(question: string): boolean {
  return (
    /\b(write|implement|add|create|build|fix|refactor|generate|code|script|function|parse|example)\b/i.test(question) ||
    /\.(ts|tsx|js|jsx|py|go|rs|java|rb|sh|sql|json|yaml|yml)\b/i.test(question)
  );
}

/** Prepend the App Map (when present) to a system prompt for global app awareness. */
function withAppMap(system: string, appMap?: string): string {
  return appMap?.trim()
    ? `${system}\n\nUse this map of the app's structure to orient yourself and connect references ` +
        `(e.g. a "privacy page" to the "/private" route) before relying on the snippets below:\n\n${appMap}`
    : system;
}

/** Prepend the `[Runtime Reference]` grounding block (when present) to a system prompt. */
function withRuntimeRef(system: string, runtimeRef?: string): string {
  return runtimeRef?.trim()
    ? `${system}\n\nGround every fact about the runtime and dependencies in this — do not guess versions, paths, or available packages:\n\n${runtimeRef}`
    : system;
}

/** Prepend the `[UI Vision Reference]` diagnostic (from the screenshot step) to a system prompt. */
function withVisionRef(system: string, visionRef?: string): string {
  return visionRef?.trim()
    ? `${system}\n\n[UI Vision Reference] — a vision model analyzed the user's screenshot(s); treat this as ground truth for what is on screen (text, errors, layout issues):\n\n${visionRef}`
    : system;
}

/** Apply the optional runtime-ref + vision grounding + code-mode rules to a base system prompt. */
function applyCodeGrounding(system: string, opts: PromptOptions): string {
  let out = withVisionRef(withRuntimeRef(system, opts.runtimeRef), opts.visionRef);
  if (opts.codeMode) out += CODE_GROUNDING_RULES;
  return out;
}

/**
 * Greedily keep chunks (best-first) until the token budget is reached, with a
 * per-file cap so one large file (e.g. a 2000-line schema whose siblings all
 * expanded in) can't crowd every other file out of the context. Once a file hits
 * the cap, later chunks of it are skipped in favor of chunks from other files.
 */
export function packContext(chunks: RetrievedChunk[], maxTokens: number, maxPerFile = 6): RetrievedChunk[] {
  const kept: RetrievedChunk[] = [];
  const perFile = new Map<string, number>();
  let used = 0;
  for (const c of chunks) {
    const count = perFile.get(c.relativePath) ?? 0;
    if (count >= maxPerFile) continue; // diversity: don't let one file dominate
    const cost = estimateTokens(c.text) + 16; // + header line
    if (kept.length > 0 && used + cost > maxTokens) break;
    kept.push(c);
    perFile.set(c.relativePath, count + 1);
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
  const baseSystem = hasContext
    ? `You are a coding assistant answering questions about the app "${appName}". ` +
      `Use the provided context${attachments.length ? ' and attached files' : ''} to answer. ` +
      'Cite the file path and line range (e.g. src/foo.ts:10-20) for facts you rely on. ' +
      'If the context does not contain the answer, say so plainly rather than guessing.'
    : `You are a helpful assistant answering from the chat for the app "${appName}", but no ` +
      'indexed code context was found for this question. If the question is general (not specific ' +
      "to this app's own code), answer it directly and accurately from your own knowledge. If it " +
      "does depend on this app's code, note that the app isn't indexed for this question yet and " +
      'answer as best you can, flagging uncertainty rather than guessing.';
  const system = applyCodeGrounding(withAppMap(baseSystem, opts.appMap), opts);

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

  const baseSystem =
    "You are a helpful assistant. Answer the user's question clearly and accurately" +
    (attachments.length ? ', using the attached files where relevant.' : '.');
  const system = applyCodeGrounding(baseSystem, opts);
  const user = att.block ? `Attached files:\n\n${att.block}\n\n---\n\nQuestion: ${question}` : question;

  return {
    messages: [{ role: 'system', content: system }, ...(opts.history ?? []), { role: 'user', content: user }],
    used: [],
  };
}
