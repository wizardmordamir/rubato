/**
 * Live streaming buffer for in-flight assistant answers.
 *
 * The /ws socket is a global broadcast, so every ask:* event reaches every tab.
 * We key buffers by `${conversationId}:${messageId}` (both server-minted before
 * the first token), so concurrent answers never collide and a page renders only
 * its own conversation's stream. Token updates are high-frequency, so this lives
 * outside react-query (which is for settled server state) and is consumed via
 * useSyncExternalStore.
 */

import { useMemo, useSyncExternalStore } from "react";
import type { ServerEvent, ToolEvent } from "@shared/types";

export interface StreamMsg {
  conversationId: string;
  messageId: string;
  text: string;
  thinking: string;
  toolEvents: ToolEvent[];
  /** Latest transient progress note (e.g. "Searching the codebase…"), pre-answer. */
  note?: string;
  status: "streaming" | "done" | "error";
  error?: string;
}

const streams = new Map<string, StreamMsg>();
const listeners = new Set<() => void>();
let version = 0;

const key = (conversationId: string, messageId: string) => `${conversationId}:${messageId}`;

function notify() {
  version++;
  for (const l of listeners) l();
}

function ensure(conversationId: string, messageId: string): StreamMsg {
  const k = key(conversationId, messageId);
  let s = streams.get(k);
  if (!s) {
    s = { conversationId, messageId, text: "", thinking: "", toolEvents: [], status: "streaming" };
    streams.set(k, s);
  }
  return s;
}

export const chatStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot(): number {
    return version;
  },

  /** Consume one ask:* event into the matching buffer. */
  applyEvent(ev: ServerEvent): void {
    switch (ev.type) {
      case "ask:started":
        ensure(ev.conversationId, ev.messageId);
        break;
      case "ask:token":
        ensure(ev.conversationId, ev.messageId).text += ev.text;
        break;
      case "ask:thinking":
        ensure(ev.conversationId, ev.messageId).thinking += ev.text;
        break;
      case "ask:status":
        ensure(ev.conversationId, ev.messageId).note = ev.text;
        break;
      case "ask:tool_call":
        ensure(ev.conversationId, ev.messageId).toolEvents.push({
          toolCallId: ev.toolCallId,
          tool: ev.tool,
          input: ev.input,
        });
        break;
      case "ask:tool_result": {
        const s = ensure(ev.conversationId, ev.messageId);
        const t = s.toolEvents.find((x) => x.toolCallId === ev.toolCallId);
        if (t) {
          t.result = ev.result;
          t.isError = ev.isError;
        }
        break;
      }
      case "ask:done":
        ensure(ev.conversationId, ev.messageId).status = "done";
        break;
      case "ask:error": {
        const s = ensure(ev.conversationId, ev.messageId);
        s.status = "error";
        s.error = ev.error;
        break;
      }
      default:
        return; // not an ask:* event
    }
    notify();
  },

  /** The in-flight stream for a conversation, if any. */
  streamFor(conversationId: string): StreamMsg | undefined {
    for (const s of streams.values()) if (s.conversationId === conversationId) return s;
    return undefined;
  },

  /** Drop a buffer once its persisted message has been refetched. */
  clear(conversationId: string, messageId: string): void {
    if (streams.delete(key(conversationId, messageId))) notify();
  },
};

/** Subscribe a component to the in-flight stream for a conversation. */
export function useChatStream(conversationId?: string): StreamMsg | undefined {
  const v = useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot);
  // biome-ignore lint/correctness/useExhaustiveDependencies: v is the change signal
  return useMemo(() => (conversationId ? chatStore.streamFor(conversationId) : undefined), [v, conversationId]);
}
