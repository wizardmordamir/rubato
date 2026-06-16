/**
 * Form-POST SSE provider: a generic provider for endpoints that accept a
 * multipart form and reply with named-event SSE. Configured purely by URL +
 * token — no service-specific names. The default event mapping covers the common
 * names (final_answer/thinking/title/error); tool events vary by backend, so map
 * them yourself via `mapEvent` when needed.
 */

import { parseSSEStream } from 'cwip';
import type { ChatChunk, LlmMessage, LlmProvider } from './types';

const STREAM_TIMEOUT_MS = 300_000;

export interface FormSseProviderConfig {
  /** Full endpoint URL the form is POSTed to. */
  baseUrl: string;
  token?: string;
  model?: string;
  /** System-prompt template field the endpoint expects. */
  promptTemplate?: string;
  temperature?: number;
  /** Map a named SSE event + data into ChatChunks (overrides the default). */
  mapEvent?: (event: string | undefined, data: string) => ChatChunk[];
  fetch?: typeof fetch;
}

/** Pull a `{content}` payload out of an event's data, tolerating raw text. */
function payload(data: string): { text: string; raw: unknown } {
  try {
    const j = JSON.parse(data) as unknown;
    if (j && typeof j === 'object' && 'content' in j) {
      const content = (j as { content: unknown }).content;
      return { text: typeof content === 'string' ? content : JSON.stringify(content), raw: content };
    }
    return { text: typeof j === 'string' ? j : JSON.stringify(j), raw: j };
  } catch {
    return { text: data, raw: data };
  }
}

function defaultMap(event: string | undefined, data: string): ChatChunk[] {
  const { text } = payload(data);
  switch (event) {
    case 'final_answer':
      return [{ kind: 'text', text }];
    case 'thinking':
      return [{ kind: 'thinking', text }];
    case 'title':
      return [{ kind: 'title', title: text }];
    case 'error':
      return [{ kind: 'error', message: text }];
    default:
      return []; // tool_call/tool_result and others: backend-specific → use mapEvent
  }
}

export function createFormSseProvider(config: FormSseProviderConfig): LlmProvider {
  const doFetch = config.fetch ?? fetch;
  const map = config.mapEvent ?? defaultMap;

  return {
    name: 'form-sse',
    async *streamChat(messages: LlmMessage[], opts = {}) {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages
        .filter((m) => m.role !== 'system')
        .map((m) => m.content)
        .join('\n\n');

      const form = new FormData();
      form.set('message', user);
      form.set('prompt_template', config.promptTemplate ?? system);
      form.set('temperature', String(opts.temperature ?? config.temperature ?? 0.2));
      const model = opts.model ?? config.model;
      if (model) form.set('model', model);

      const res = await doFetch(config.baseUrl, {
        method: 'POST',
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
        body: form,
        signal: opts.signal ?? AbortSignal.timeout(STREAM_TIMEOUT_MS),
      });
      if (!res.ok || !res.body) {
        yield { kind: 'error', message: `provider returned ${res.status} ${res.statusText}` };
        return;
      }
      for await (const ev of parseSSEStream(res.body)) {
        for (const chunk of map(ev.event, ev.data)) yield chunk;
      }
      yield { kind: 'done' };
    },
  };
}
