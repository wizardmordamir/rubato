/**
 * Drain a streaming provider into a single string. Used for non-conversational
 * internal calls (e.g. the self-ask retrieval planner) where we want the whole
 * reply, not a token stream. Thinking/tool/title chunks are ignored; an `error`
 * chunk throws, matching how the streaming caller treats it.
 */

import type { ChatOptions, LlmMessage, LlmProvider } from './types';

export async function completeText(provider: LlmProvider, messages: LlmMessage[], opts?: ChatOptions): Promise<string> {
  let text = '';
  for await (const chunk of provider.streamChat(messages, opts)) {
    if (chunk.kind === 'text') text += chunk.text;
    else if (chunk.kind === 'error') throw new Error(chunk.message);
  }
  return text;
}
