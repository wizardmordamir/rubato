/**
 * Native-Ollama LLM provider: streams from Ollama's `/api/chat` (ndjson) rather
 * than the OpenAI-compat `/v1/chat/completions`. The native endpoint is the only
 * one that honors runtime `options` — chiefly `num_ctx` (the context window) and
 * `repeat_penalty` — which the OpenAI-compat layer silently drops. Those are the
 * levers that fix "context blindness", so a code-assistant on a big-context model
 * (e.g. qwen2.5-coder:14b at 32k) needs this transport.
 *
 * Emits the same normalized `ChatChunk`s as `createDirectProvider`, so every
 * caller (ask / agenticAsk / forge) is unchanged — only `fromConfig` chooses it.
 */

import { type AuthConfig, createApiClient } from '../client';
import type { ChatChunk, ChatOptions, LlmMessage, LlmProvider } from './types';

const STREAM_TIMEOUT_MS = 300_000; // 5 min — long answers shouldn't time out

export interface OllamaProviderConfig {
  /** Base URL of the Ollama endpoint; an OpenAI-compat `/v1[/chat/completions]` suffix is stripped. */
  baseUrl: string;
  auth?: AuthConfig;
  model?: string;
  /** Default Ollama `options` merged into every request (num_ctx, temperature, repeat_penalty, top_p, …). */
  options?: Record<string, unknown>;
  /** Reasoning toggle/budget for thinking-capable models (DeepSeek-R1, qwen3, …). */
  think?: boolean | 'low' | 'medium' | 'high';
  fetch?: typeof fetch;
}

/** One ndjson line from `/api/chat`. */
interface OllamaStreamLine {
  message?: { role?: string; content?: string; thinking?: string };
  done?: boolean;
  error?: string;
}

/** Strip an OpenAI-compat `/v1[/chat/completions]` suffix to reach Ollama's native API root. */
export function nativeOllamaRoot(baseUrl: string): string {
  return baseUrl
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '')
    .replace(/\/v1$/, '');
}

/** Turn one complete ndjson line into normalized chunks; a partial/garbled line is skipped (never fatal). */
function parseLine(line: string): ChatChunk[] {
  let json: OllamaStreamLine;
  try {
    json = JSON.parse(line) as OllamaStreamLine;
  } catch {
    return [];
  }
  if (json.error) return [{ kind: 'error', message: json.error }];
  const out: ChatChunk[] = [];
  if (json.message?.thinking) out.push({ kind: 'thinking', text: json.message.thinking });
  if (json.message?.content) out.push({ kind: 'text', text: json.message.content });
  if (json.done) out.push({ kind: 'done' });
  return out;
}

export function createOllamaProvider(config: OllamaProviderConfig): LlmProvider {
  const api = createApiClient({
    name: 'llm-ollama',
    baseUrl: nativeOllamaRoot(config.baseUrl),
    auth: config.auth,
    timeoutMs: STREAM_TIMEOUT_MS,
    fetch: config.fetch,
  });

  return {
    name: 'ollama',
    async *streamChat(messages: LlmMessage[], opts: ChatOptions = {}) {
      const options = { ...config.options, ...opts.options };
      const think = opts.think ?? config.think;
      const body: Record<string, unknown> = {
        model: opts.model ?? config.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        ...(think !== undefined ? { think } : {}),
        ...(Object.keys(options).length ? { options } : {}),
      };

      const res = await api.post('api/chat', body, {
        responseType: 'stream',
        signal: opts.signal,
        timeoutMs: STREAM_TIMEOUT_MS,
      });
      const stream = res.data as ReadableStream<Uint8Array> | null;
      if (!stream) {
        yield { kind: 'error', message: 'Ollama returned no response stream' };
        return;
      }

      // Line-buffered ndjson: accumulate bytes, split on newlines, parse only
      // COMPLETE lines so a TCP packet that splits a JSON object never throws.
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const nl = buffer.indexOf('\n');
            if (nl === -1) break;
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) for (const chunk of parseLine(line)) yield chunk;
          }
        }
        const tail = buffer.trim();
        if (tail) for (const chunk of parseLine(tail)) yield chunk;
      } finally {
        reader.releaseLock();
      }
      yield { kind: 'done' };
    },
  };
}
