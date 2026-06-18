/**
 * The ask worker: turn a question about an app into a streamed, persisted answer.
 *
 * `startAsk` does the synchronous setup (resolve/create the conversation, persist
 * the user message, mint the assistant messageId) and returns immediately; the
 * answer then streams over /ws as ask:token events and is persisted on completion.
 * The LLM parsing is already incremental (see api/llm/sse), so a token reaches the
 * browser as soon as its SSE event completes.
 */

import { randomUUID } from 'node:crypto';
import { completeText } from '../api/llm/complete';
import { llmFromConfig } from '../api/llm/fromConfig';
import type { LlmMessage, LlmProvider } from '../api/llm/types';
import { formatIssuesForRepair, runCodeChecks } from '../lib/ai/codeCheck';
import { buildGeneralPrompt, buildPrompt, isCodeQuestion } from '../lib/ai/prompt';
import { buildRuntimeRef } from '../lib/ai/runtimeRef';
import { buildPlannerPrompt, parseDecision } from '../lib/ai/selfAsk';
import { estimateTokens } from '../lib/ai/tokens';
import type { RetrievedChunk } from '../lib/ai/types';
import { DEFAULT_VISION_MODEL, extractVisionDiagnostic } from '../lib/ai/visionExtract';
import type { AppConfig } from '../lib/apps';
import { loadConfig } from '../lib/config';
import { startDiagnostics } from '../lib/diagnostics';
import type { AskAttachment, AskSource, ToolEvent } from '../shared/types';
import { runAgenticGather } from './agenticAsk';
import { getAppMap, getStatus } from './aiDb';
import { indexApp } from './aiIndex';
import { retrieve } from './aiRetrieve';
import { addMessage, createConversation, getConversation, getMessages, setConversationTitle } from './db';
import { emit } from './events';
import { Tracer } from './trace';

/** Hard cap on chunks accumulated across self-ask rounds (loop backstop; scales with the larger context window). */
const MAX_TOTAL_CHUNKS = 120;

/**
 * Gather context for a question, optionally over several self-ask rounds: each
 * round retrieves (with file expansion), then the planner LLM judges whether
 * that's enough and, if not, proposes follow-up searches. Bounded by
 * `maxRounds`, by per-query and per-chunk dedup, by a total-chunk budget, and by
 * an "added nothing new → stop" check — so it always terminates. Planner failure
 * ends the loop with whatever's gathered (retrieval never breaks the ask).
 */
async function gatherContext(
  app: AppConfig,
  question: string,
  provider: LlmProvider,
  model: string | undefined,
  maxRounds: number,
  onStatus?: (text: string) => void,
  tracer?: Tracer,
): Promise<RetrievedChunk[]> {
  const gathered: RetrievedChunk[] = [];
  const seenChunks = new Set<string>();
  const seenQueries = new Set<string>();
  let queries = [question];

  for (let round = 0; round < maxRounds; round++) {
    onStatus?.(round === 0 ? 'Searching the codebase…' : 'Searching for more…');
    let added = 0;
    const ran: string[] = [];
    const runRetrieval = async () => {
      for (const q of queries) {
        const norm = q.trim().toLowerCase();
        if (!norm || seenQueries.has(norm)) continue;
        seenQueries.add(norm);
        ran.push(q.trim());
        for (const c of await retrieve(app, q)) {
          const key = `${c.relativePath}:${c.startLine}`;
          if (seenChunks.has(key)) continue;
          seenChunks.add(key);
          gathered.push(c);
          added++;
        }
      }
    };
    if (tracer) {
      await tracer.span(`Retrieval round ${round + 1}`, 'retrieval', runRetrieval, () => ({
        detail: `${ran.length ? ran.join(' · ') : '—'} → +${added} chunks`,
      }));
    } else {
      await runRetrieval();
    }

    // Stop on the last allowed round, when nothing new surfaced, or at budget.
    if (round === maxRounds - 1 || added === 0 || gathered.length >= MAX_TOTAL_CHUNKS) break;

    // Planner: enough to answer? If not, what to search next? Failure ends it.
    onStatus?.("Checking if that's enough…");
    try {
      const decide = async () => {
        const reply = await completeText(provider, buildPlannerPrompt(question, gathered), { model });
        return parseDecision(reply);
      };
      const decision = tracer ? await tracer.span('Planner check', 'planner', decide) : await decide();
      if (decision.sufficient) break;
      queries = decision.queries;
    } catch {
      break;
    }
  }

  return gathered;
}

export interface AskInput {
  /** The app to ground the answer in, or undefined for a general (no-repo) question. */
  app?: AppConfig;
  question: string;
  conversationId?: string;
  /** Files attached to the question, sent as ad-hoc context. */
  attachments?: AskAttachment[];
  /** A folder the AI may explore with read-only filesystem tools (general mode, no app). */
  fsRoot?: string;
  /** Screenshot(s) as raw base64 (no data-URL header) — triggers the vision→code pipeline. */
  images?: string[];
}

export interface AskResult {
  conversationId: string;
  messageId: string;
}

/** A short conversation title derived from the first question. */
function deriveTitle(question: string): string {
  const t = question.trim().replace(/\s+/g, ' ');
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

/**
 * Set up the conversation + user message synchronously, then stream the answer in
 * the background. Returns the ids the UI keys the live stream on.
 */
export function startAsk(input: AskInput): AskResult {
  const { app, question, attachments, images } = input;

  // A thread is bound to the folder it was created with: persist it on a new
  // conversation, and reuse the stored one when continuing (so reloaded chats
  // keep their folder even if the client doesn't resend it).
  const existing = input.conversationId ? getConversation(input.conversationId) : null;
  let conversationId: string;
  let fsRoot = input.fsRoot;
  if (existing) {
    conversationId = existing.id;
    fsRoot = existing.fsRoot ?? fsRoot;
  } else {
    conversationId = createConversation(app?.name, fsRoot).id;
    setConversationTitle(conversationId, deriveTitle(question));
  }
  addMessage({ conversationId, role: 'user', content: question });

  const messageId = randomUUID();
  emit({ type: 'ask:started', conversationId, messageId, app: app?.name, question });

  // Fire-and-forget; the answer arrives over the socket.
  streamAnswer(app, question, conversationId, messageId, attachments, fsRoot, images).catch((err) => {
    const error = err instanceof Error ? err.message : String(err);
    // Durable, exportable record of the failure — the answer message is ephemeral
    // and lossy; the diagnostic carries the classification, stack, and HTTP context.
    const diag = startDiagnostics({
      activity: 'ask',
      intent: `answer: ${deriveTitle(question)}`,
      console: false,
    });
    diag.fail(err, { app: app?.name ?? '(general)', conversationId, messageId });
    void diag.finish('error');
    addMessage({ id: messageId, conversationId: conversationId as string, role: 'assistant', content: `⚠ ${error}` });
    emit({ type: 'ask:error', conversationId: conversationId as string, messageId, error });
  });

  return { conversationId, messageId };
}

/**
 * Prior turns of a conversation as chat messages (multi-turn memory). Drops the
 * last persisted message — the current question, which is sent separately — and
 * any empty/errored turns, then keeps the most recent within a message + token
 * budget (trimming oldest-first so the latest context always survives).
 */
function loadHistory(conversationId: string, maxMessages: number, maxTokens: number): LlmMessage[] {
  if (maxMessages <= 0) return [];
  const prior = getMessages(conversationId)
    .slice(0, -1) // the current question is the latest persisted message
    .filter((m) => m.content.trim() && !m.content.startsWith('⚠'))
    .map((m): LlmMessage => ({ role: m.role, content: m.content }));

  const recent = prior.slice(-maxMessages);
  let total = recent.reduce((n, m) => n + estimateTokens(m.content) + 8, 0);
  while (recent.length > 1 && total > maxTokens) {
    const dropped = recent.shift();
    if (dropped) total -= estimateTokens(dropped.content) + 8;
  }
  return recent;
}

async function streamAnswer(
  app: AppConfig | undefined,
  question: string,
  conversationId: string,
  messageId: string,
  attachments?: AskAttachment[],
  fsRoot?: string,
  images?: string[],
): Promise<void> {
  // Transient progress, so the user sees activity before answer tokens flow.
  const status = (text: string) => emit({ type: 'ask:status', conversationId, messageId, text });
  // Times each phase; rides along on the persisted message for the debug panel.
  const tracer = new Tracer();

  const cfg = await loadConfig();
  const provider = await llmFromConfig(app);
  const model = app?.ai?.model ?? cfg.ai?.direct?.model;
  const maxContextTokens = app?.ai?.maxContextTokens ?? cfg.ai?.maxContextTokens ?? 6000;

  // Code grounding/enhance: opt-out flags (default on), gated to code-shaped questions.
  const codeGrounding = app?.ai?.codeGrounding ?? cfg.ai?.codeGrounding ?? true;
  const codeEnhance = app?.ai?.codeEnhance ?? cfg.ai?.codeEnhance ?? true;
  const codeEnhanceTsc = app?.ai?.codeEnhanceTsc ?? cfg.ai?.codeEnhanceTsc ?? false;
  const codeMode = codeGrounding && isCodeQuestion(question);
  // The self-repair turn re-sends the first answer, so it needs headroom; the
  // effective num_ctx (unset ⇒ Ollama's small default) gates it.
  const numCtx = app?.ai?.numCtx ?? cfg.ai?.direct?.numCtx ?? 0;
  // Real runtime/deps/tool grounding — only for app-scoped code questions (needs a repo).
  const runtimeRef = app && codeMode ? await buildRuntimeRef(app, question).catch(() => undefined) : undefined;

  // Step 1 of the vision→code pipeline: if the question carries screenshot(s), a
  // local vision model extracts a markdown diagnostic (OCR + errors + layout
  // issues), injected below as a `[UI Vision Reference]` block so the text code
  // model (Step 2) acts on it through the normal RAG + code-check + self-repair
  // loop. Requires the native Ollama transport (only it forwards `images`).
  let visionRef: string | undefined;
  if (images?.length) {
    const ollamaFlavor = (app?.ai?.flavor ?? cfg.ai?.direct?.flavor) === 'ollama';
    if (!ollamaFlavor) {
      status('Screenshots need the Ollama transport (set ai.direct.flavor = "ollama"); ignoring images.');
    } else {
      const visionModel = app?.ai?.visionModel ?? cfg.ai?.visionModel ?? DEFAULT_VISION_MODEL;
      status(`Analyzing ${images.length} screenshot${images.length === 1 ? '' : 's'} with ${visionModel}…`);
      try {
        visionRef = await tracer.span(
          'Vision extraction',
          'vision',
          () => extractVisionDiagnostic(provider, images, question, { model: visionModel }),
          () => ({ detail: `${images.length} image(s) → ${visionModel}` }),
        );
      } catch (err) {
        // Vision is best-effort: a model that isn't pulled / a transport hiccup must
        // not sink the whole answer — fall through to a text-only answer with a note.
        status(`Vision step failed (${err instanceof Error ? err.message : 'error'}); answering from text only.`);
      }
    }
  }

  // Multi-turn memory: replay prior turns of this conversation, bounded.
  const maxHistoryMessages = app?.ai?.maxHistoryMessages ?? cfg.ai?.maxHistoryMessages ?? 20;
  const maxHistoryTokens = app?.ai?.maxHistoryTokens ?? cfg.ai?.maxHistoryTokens ?? 3000;
  const history = loadHistory(conversationId, maxHistoryMessages, maxHistoryTokens);

  let messages: LlmMessage[];
  let answerSources: AskSource[] = [];
  const toolEvents: ToolEvent[] = [];
  // Tracks which gather strategy ran, for the persisted trace.
  let mode: 'agentic' | 'self-ask' | 'general';

  if (!app && fsRoot) {
    // General + a chosen folder: let the model explore it with read-only
    // filesystem tools (no index). Picking a folder is itself the opt-in.
    mode = 'agentic';
    const maxToolRounds = Math.max(1, cfg.ai?.maxToolRounds ?? 4);
    const gathered = await runAgenticGather({
      fsRoot,
      question,
      provider,
      model,
      conversationId,
      messageId,
      maxRounds: maxToolRounds,
      history,
      codeMode,
      visionRef,
      tracer,
    });
    messages = gathered.messages;
    answerSources = gathered.sources;
    toolEvents.push(...gathered.toolEvents);
  } else if (!app) {
    // General (no-repo) chat: skip retrieval entirely; just the question + any
    // attached files. Honors the same context budget for the attachments.
    mode = 'general';
    messages = buildGeneralPrompt(question, { maxContextTokens, attachments, history, codeMode, visionRef }).messages;
  } else {
    // Index lazily on the first question about an app.
    if (!getStatus(app.name)) {
      status(`Indexing ${app.name} (first question)…`);
      await tracer.span('Index (first question)', 'index', () => indexApp(app), { detail: app.name });
    }

    // Global app awareness: the compact App Map (routes/endpoints/dirs) built at
    // index time, prepended to the system prompt so the model isn't blind to the
    // app's shape before retrieval even runs.
    const appMap = getAppMap(app.name) ?? undefined;

    // Two gather strategies. Tools (opt-in): the model drives retrieval via the
    // tool protocol, then we stream the answer from the accumulated transcript.
    // Otherwise: the bounded self-ask loop packs a one-shot context prompt.
    const toolsEnabled = app.ai?.tools ?? cfg.ai?.tools ?? false;
    if (toolsEnabled) {
      mode = 'agentic';
      const maxToolRounds = Math.max(1, app.ai?.maxToolRounds ?? cfg.ai?.maxToolRounds ?? 4);
      const gathered = await runAgenticGather({
        app,
        question,
        provider,
        model,
        conversationId,
        messageId,
        maxRounds: maxToolRounds,
        history,
        appMap,
        runtimeRef,
        codeMode,
        visionRef,
        tracer,
      });
      messages = gathered.messages;
      answerSources = gathered.sources;
      toolEvents.push(...gathered.toolEvents); // tool rounds already emitted live
    } else {
      mode = 'self-ask';
      const maxRounds = Math.max(1, app.ai?.maxRetrievalRounds ?? cfg.ai?.maxRetrievalRounds ?? 4);
      const chunks = await gatherContext(app, question, provider, model, maxRounds, status, tracer);
      const built = buildPrompt(app.name, question, chunks, {
        maxContextTokens,
        attachments,
        history,
        appMap,
        runtimeRef,
        codeMode,
        visionRef,
      });
      messages = built.messages;
      answerSources = built.used.map((c) => ({
        relativePath: c.relativePath,
        startLine: c.startLine,
        endLine: c.endLine,
        score: c.score,
      }));
    }
  }

  status('Writing the answer…');
  let answer = '';
  let thinking = '';
  let firstTokenMs: number | undefined;

  await tracer.span(
    'Answer (LLM stream)',
    'answer',
    () => streamAndCollect(),
    () => ({ detail: firstTokenMs !== undefined ? `first token ${firstTokenMs}ms` : undefined }),
  );

  async function streamAndCollect(): Promise<void> {
    const startedAt = Date.now();
    for await (const chunk of provider.streamChat(messages, { model })) {
      switch (chunk.kind) {
        case 'text':
          if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
          answer += chunk.text;
          emit({ type: 'ask:token', conversationId, messageId, text: chunk.text });
          break;
        case 'thinking':
          thinking += chunk.text;
          emit({ type: 'ask:thinking', conversationId, messageId, text: chunk.text });
          break;
        case 'tool': {
          const existing = toolEvents.find((t) => t.toolCallId === chunk.toolCallId);
          if (existing) {
            existing.result = chunk.result;
            existing.isError = chunk.isError;
            emit({
              type: 'ask:tool_result',
              conversationId,
              messageId,
              toolCallId: chunk.toolCallId,
              result: chunk.result,
              isError: chunk.isError,
            });
          } else {
            toolEvents.push({ toolCallId: chunk.toolCallId, tool: chunk.tool, input: chunk.input });
            emit({
              type: 'ask:tool_call',
              conversationId,
              messageId,
              toolCallId: chunk.toolCallId,
              tool: chunk.tool,
              input: chunk.input,
            });
          }
          break;
        }
        case 'title':
          setConversationTitle(conversationId, chunk.title);
          emit({ type: 'ask:title', conversationId, title: chunk.title });
          break;
        case 'error':
          throw new Error(chunk.message);
        case 'done':
          break;
      }
    }
  }

  // Post-generation safety net for code answers: check the buffered answer and, if
  // automated checks surface issues, do exactly one self-repair turn before
  // persisting. Chat-only (not general no-repo); gated on context headroom because
  // the repair turn re-sends the first answer. codeEnhanceTsc adds the opt-in tsc pass.
  if (codeEnhance && mode !== 'general' && isCodeQuestion(question)) {
    if (numCtx >= 8192) {
      const { issues } = await runCodeChecks(answer, { withTsc: codeEnhanceTsc });
      if (issues.length) {
        emit({ type: 'ask:repair_started', conversationId, messageId, issues: issues.map((i) => i.message) });
        messages.push({ role: 'assistant', content: answer });
        messages.push({
          role: 'user',
          content:
            'The code in your previous answer has issues found by automated checks. ' +
            'Re-output the ENTIRE corrected answer (not a diff), fixing every issue below and ' +
            'keeping everything else the same:\n\n' +
            formatIssuesForRepair(issues),
        });
        // Reset the buffers so we stream + persist only the corrected answer (over
        // the same messageId; the UI clears the message on ask:repair_started).
        answer = '';
        thinking = '';
        firstTokenMs = undefined;
        await tracer.span(
          'Answer (self-repair)',
          'answer',
          () => streamAndCollect(),
          () => ({ detail: `${issues.length} issue(s) fixed` }),
        );
      }
    } else {
      status('Skipping code self-repair (context window < 8192).');
    }
  }

  const message = addMessage({
    id: messageId,
    conversationId,
    role: 'assistant',
    content: answer,
    thinking: thinking || undefined,
    toolEvents: toolEvents.length ? toolEvents : undefined,
    sources: answerSources.length ? answerSources : undefined,
    model,
    trace: tracer.finish(mode, model),
  });
  emit({ type: 'ask:done', conversationId, messageId, message });
}
