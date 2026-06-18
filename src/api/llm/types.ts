/**
 * Provider-agnostic LLM + embedding contracts.
 *
 * The rest of the AI feature talks to these interfaces, never to a concrete
 * endpoint. `streamChat` yields normalized chunks (text/thinking/tool/done/error)
 * regardless of whether the underlying transport is OpenAI-style SSE, ndjson, or
 * a form-POST SSE endpoint — the parsing lives in each provider, not the caller.
 */

/** A chat message as sent to a provider (distinct from the persisted wire ChatMessage). */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * Raw base64 image data (NO `data:` URL header) for multimodal turns. Only the
   * native Ollama transport forwards these (as the message's `images` array); the
   * OpenAI-compat/form transports ignore them, so vision needs `flavor: "ollama"`.
   */
  images?: string[];
}

/** One normalized piece of a streamed response. */
export type ChatChunk =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolCallId: string; tool: string; input?: unknown; result?: unknown; isError?: boolean }
  | { kind: 'title'; title: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Ollama native `options` passthrough (num_ctx, repeat_penalty, top_p, …); honored by the ollama provider. */
  options?: Record<string, unknown>;
  /** Reasoning toggle/budget for thinking-capable models (Ollama native). */
  think?: boolean | 'low' | 'medium' | 'high';
}

/** Streams a chat completion as normalized chunks. */
export interface LlmProvider {
  readonly name: string;
  streamChat(messages: LlmMessage[], opts?: ChatOptions): AsyncIterable<ChatChunk>;
}

/** Turns text into vectors. Runs locally (no network) for the default provider. */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  /** Batch-embed; returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}
