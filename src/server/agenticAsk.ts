/**
 * Agentic tool loop (Tier 2 retrieval). When `ai.tools` is on, the model gathers
 * context by calling tools through the provider-agnostic JSON protocol
 * (toolProtocol) instead of a single retrieval: each round it may request tool
 * calls, we run them against the app and feed back observations, until it stops
 * asking — then the caller streams the final answer from the accumulated
 * transcript. Bounded by rounds, per-round and total call caps, exact-call dedup,
 * and fail-safe parsing, so it always terminates and degrades to the seeded
 * retrieval if the model never (validly) calls a tool.
 */

import { completeText } from '../api/llm/complete';
import type { LlmMessage, LlmProvider } from '../api/llm/types';
import { CODE_GROUNDING_RULES } from '../lib/ai/prompt';
import {
  formatObservations,
  type ObservationLine,
  parseToolUse,
  renderToolInstructions,
  type ToolCall,
  validateCall,
} from '../lib/ai/toolProtocol';
import type { AppConfig } from '../lib/apps';
import type { AskSource, ToolEvent } from '../shared/types';
import { retrieve } from './aiRetrieve';
import { emit } from './events';
import { getFsTools } from './tools/fsTools';
import { getToolsForApp } from './tools/registry';
import type { RepoTool, ToolContext } from './tools/types';
import type { Tracer } from './trace';

const MAX_CALLS_PER_ROUND = 5;
const MAX_TOTAL_CALLS = 14;

export interface AgenticGatherArgs {
  /** App-scoped mode: tools read the app's indexed files. */
  app?: AppConfig;
  /** General filesystem mode: tools explore this directory directly (no index). */
  fsRoot?: string;
  question: string;
  provider: LlmProvider;
  model: string | undefined;
  conversationId: string;
  messageId: string;
  maxRounds: number;
  /** Prior conversation turns to replay (multi-turn memory), oldest-first. */
  history?: LlmMessage[];
  /** Compact App Map prepended to the system prompt for global app awareness. */
  appMap?: string;
  /** `[Runtime Reference]` grounding block (Bun version, app path, deps, tool versions). */
  runtimeRef?: string;
  /** When set, append the code-generation rules + few-shot anchors to the system prompt. */
  codeMode?: boolean;
  /** `[UI Vision Reference]` markdown diagnostic from the screenshot-extraction step. */
  visionRef?: string;
  /** Optional timing recorder; records seed retrieval, model rounds, tool calls. */
  tracer?: Tracer;
}

export interface AgenticGatherResult {
  /** Transcript + a final "now answer" turn, ready for the caller to stream. */
  messages: LlmMessage[];
  toolEvents: ToolEvent[];
  sources: AskSource[];
}

/** A short, single-line preview of tool params for the debug trace. */
function summarizeParams(params: unknown): string | undefined {
  try {
    const s = JSON.stringify(params);
    if (!s || s === '{}') return undefined;
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  } catch {
    return undefined;
  }
}

function baseSystem(appName: string): string {
  return (
    `You are a coding assistant answering questions about the app "${appName}". ` +
    'Use the tools to gather facts from the codebase, then answer using only what you find. ' +
    'Cite file paths and line ranges (e.g. src/foo.ts:10-20). If the codebase does not contain ' +
    'the answer, say so plainly rather than guessing.'
  );
}

function fsSystem(root: string): string {
  return (
    `You are an assistant answering questions about files in the directory "${root}". ` +
    'Use the tools to list, read, and search files there, then answer using only what you find. ' +
    'Cite file paths relative to that directory. You can only read inside this folder — not outside ' +
    'it, and never secret/credential files. If the folder does not contain the answer, say so plainly.'
  );
}

export async function runAgenticGather(args: AgenticGatherArgs): Promise<AgenticGatherResult> {
  const {
    app,
    fsRoot,
    question,
    provider,
    model,
    conversationId,
    messageId,
    maxRounds,
    history,
    appMap,
    runtimeRef,
    codeMode,
    visionRef,
    tracer,
  } = args;
  const status = (text: string) => emit({ type: 'ask:status', conversationId, messageId, text });

  // Two tool sets: app-scoped (indexed repo tools) or general filesystem tools
  // bound to a folder. The rest of the loop is identical for both.
  const tools = app ? await getToolsForApp(app) : getFsTools(fsRoot ?? '');
  const toolCtx: ToolContext = app ? { app } : {};
  const byName = new Map<string, RepoTool>(tools.map((t) => [t.spec.name, t]));

  const toolEvents: ToolEvent[] = [];
  const sources: AskSource[] = [];
  const sourceKeys = new Set<string>();
  const ran = new Set<string>();
  let totalCalls = 0;

  const addSource = (s: AskSource) => {
    const key = `${s.relativePath}:${s.startLine}-${s.endLine}`;
    if (!sourceKeys.has(key)) {
      sourceKeys.add(key);
      sources.push(s);
    }
  };

  // App mode seeds with an initial retrieval so a no-tool answer still has context;
  // filesystem mode has no index, so the model explores via the tools.
  let seedContext = '(use the tools to explore the folder)';
  let system = fsSystem(fsRoot ?? '');
  if (app) {
    status('Searching the codebase…');
    let seedCount = 0;
    const seed = tracer
      ? await tracer.span(
          'Seed retrieval',
          'retrieval',
          async () => {
            const r = await retrieve(app, question);
            seedCount = r.length;
            return r;
          },
          () => ({ detail: `${seedCount} chunks` }),
        )
      : await retrieve(app, question);
    seedContext = seed.length
      ? seed.map((c) => `// ${c.relativePath}:${c.startLine}-${c.endLine}\n${c.text}`).join('\n\n')
      : '(no indexed context matched)';
    system = baseSystem(app.name);
    for (const c of seed)
      addSource({ relativePath: c.relativePath, startLine: c.startLine, endLine: c.endLine, score: c.score });
  }

  const mapBlock = appMap?.trim()
    ? `\n\nUse this map of the app's structure to orient yourself and connect references ` +
      `(e.g. a "privacy page" to the "/private" route) before using the tools:\n\n${appMap}`
    : '';
  const runtimeBlock = runtimeRef?.trim()
    ? `\n\nGround every fact about the runtime and dependencies in this — do not guess versions, paths, or available packages:\n\n${runtimeRef}`
    : '';
  const visionBlock = visionRef?.trim()
    ? `\n\n[UI Vision Reference] — a vision model analyzed the user's screenshot(s); treat this as ground truth for what is on screen (text, errors, layout issues):\n\n${visionRef}`
    : '';
  const rulesBlock = codeMode ? CODE_GROUNDING_RULES : '';
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: `${system}${mapBlock}${runtimeBlock}${visionBlock}\n\n${renderToolInstructions(tools.map((t) => t.spec))}${rulesBlock}`,
    },
    ...(history ?? []),
    { role: 'user', content: `Question: ${question}\n\nInitial context:\n${seedContext}` },
  ];

  /** Run one validated/looked-up call, emitting live tool events. */
  async function execute(call: ToolCall): Promise<ObservationLine> {
    emit({
      type: 'ask:tool_call',
      conversationId,
      messageId,
      toolCallId: call.id,
      tool: call.tool,
      input: call.params,
    });
    const finish = (ok: boolean, content: string): ObservationLine => {
      toolEvents.push({ toolCallId: call.id, tool: call.tool, input: call.params, result: content, isError: !ok });
      emit({ type: 'ask:tool_result', conversationId, messageId, toolCallId: call.id, result: content, isError: !ok });
      return { id: call.id, tool: call.tool, ok, content };
    };

    const tool = byName.get(call.tool);
    if (!tool) return finish(false, `unknown tool "${call.tool}"`);
    const valid = validateCall(tool.spec, call);
    if (!valid.ok) return finish(false, valid.error);

    const sig = `${call.tool}:${JSON.stringify(valid.params)}`;
    if (ran.has(sig)) return finish(true, '(already ran this exact call — use the earlier result)');
    ran.add(sig);

    try {
      const run = () => tool.run(toolCtx, valid.params);
      let ok = false;
      const result = tracer
        ? await tracer.span(
            `Tool: ${call.tool}`,
            'tool',
            async () => {
              const r = await run();
              ok = r.ok;
              return r;
            },
            () => ({ ok, detail: summarizeParams(valid.params) }),
          )
        : await run();
      for (const s of result.sources ?? []) addSource(s);
      return finish(result.ok, result.content);
    } catch (err) {
      return finish(false, `tool error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (let round = 0; round < maxRounds; round++) {
    status(round === 0 ? 'Looking through the code…' : 'Following up on what I found…');
    let reply: string;
    try {
      const complete = () => completeText(provider, messages, { model });
      reply = tracer ? await tracer.span(`Model round ${round + 1}`, 'llm', complete) : await complete();
    } catch {
      break; // model/transport failure → answer from what we have
    }
    const calls = parseToolUse(reply);
    if (!calls) break; // no tool block → the model is ready to answer

    messages.push({ role: 'assistant', content: reply });

    const observations: ObservationLine[] = [];
    for (const call of calls.slice(0, MAX_CALLS_PER_ROUND)) {
      if (totalCalls >= MAX_TOTAL_CALLS) {
        observations.push({ id: call.id, tool: call.tool, ok: false, content: 'tool budget reached — answer now' });
        break;
      }
      totalCalls++;
      status(`Running ${call.tool}…`);
      observations.push(await execute(call));
    }
    messages.push({ role: 'user', content: formatObservations(observations) });
  }

  messages.push({
    role: 'user',
    content:
      'You now have enough information. Answer the question concisely in prose, citing file ' +
      'paths and line ranges. Do not emit a tool_use block.',
  });
  return { messages, toolEvents, sources };
}
