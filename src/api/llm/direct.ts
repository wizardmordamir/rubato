/**
 * Direct LLM provider: calls an OpenAI-compatible chat endpoint and streams the
 * response as normalized ChatChunks. The request body and per-event parsing are
 * overridable (buildRequest / parseEvent) so non-OpenAI shapes — custom agent
 * endpoints, other gateways — work without changing callers.
 */

import { parseSSEStream } from 'cwip';
import { type AuthConfig, createApiClient } from '../client';
import type { ChatChunk, ChatOptions, LlmMessage, LlmProvider } from './types';

const DEFAULT_PATH = 'chat/completions';
const STREAM_TIMEOUT_MS = 300_000; // 5 min — long answers shouldn't time out

export interface DirectProviderConfig {
  baseUrl: string;
  /** Path appended to baseUrl. Default "chat/completions". */
  path?: string;
  auth?: AuthConfig;
  model?: string;
  temperature?: number;
  /** Build the request body from messages+opts. Default = OpenAI chat shape. */
  buildRequest?: (messages: LlmMessage[], opts: ChatOptions) => unknown;
  /** Turn one SSE `data:` payload into ChatChunks. Default = OpenAI delta parse. */
  parseEvent?: (data: string) => ChatChunk[];
  fetch?: typeof fetch;
}

/** One streamed chunk of an OpenAI-style chat completion. */
interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
}

function defaultBuildRequest(
  messages: LlmMessage[],
  opts: ChatOptions,
  model: string | undefined,
  temperature: number | undefined,
): unknown {
  return {
    model: opts.model ?? model,
    messages,
    temperature: opts.temperature ?? temperature ?? 0.2,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    stream: true,
  };
}

function defaultParseEvent(data: string): ChatChunk[] {
  if (data.trim() === '[DONE]') return [{ kind: 'done' }];
  let json: OpenAiStreamChunk;
  try {
    json = JSON.parse(data) as OpenAiStreamChunk;
  } catch {
    return []; // not JSON (shouldn't happen once a line is complete) — skip
  }
  const choice = json.choices?.[0];
  if (!choice) return [];
  const out: ChatChunk[] = [];
  if (choice.delta?.content) out.push({ kind: 'text', text: choice.delta.content });
  if (choice.delta?.reasoning_content) out.push({ kind: 'thinking', text: choice.delta.reasoning_content });
  if (choice.finish_reason) out.push({ kind: 'done' });
  return out;
}

export function createDirectProvider(config: DirectProviderConfig): LlmProvider {
  const api = createApiClient({
    name: 'llm-direct',
    baseUrl: config.baseUrl,
    auth: config.auth,
    timeoutMs: STREAM_TIMEOUT_MS,
    fetch: config.fetch,
  });
  const path = config.path ?? DEFAULT_PATH;
  const parse = config.parseEvent ?? defaultParseEvent;

  return {
    name: 'direct',
    async *streamChat(messages, opts = {}) {
      const body = config.buildRequest
        ? config.buildRequest(messages, opts)
        : defaultBuildRequest(messages, opts, config.model, config.temperature);

      const res = await api.post(path, body, {
        responseType: 'stream',
        signal: opts.signal,
        timeoutMs: STREAM_TIMEOUT_MS,
      });
      const stream = res.data as ReadableStream<Uint8Array> | null;
      if (!stream) {
        yield { kind: 'error', message: 'LLM returned no response stream' };
        return;
      }
      for await (const ev of parseSSEStream(stream)) {
        for (const chunk of parse(ev.data)) yield chunk;
      }
      yield { kind: 'done' };
    },
  };
}
