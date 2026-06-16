/**
 * Functional: the "Ask" streaming path end-to-end over a live WebSocket. A real
 * server + a real WS client; a general (no-app) question streams from the fake
 * LLM and arrives as `ask:*` events. This is the websocket flow the provider-level
 * integration test (llm.int.test.ts) can't reach.
 */

import { describe, expect, test } from 'bun:test';
import type { ServerEvent } from '../../shared/types';
import { useFunctional } from '../index';

const h = useFunctional();

function deadline(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms));
}

function openWs(baseUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws connection failed'));
  });
}

describe('Ask streaming over /ws', () => {
  test('a general question streams tokens from the fake LLM to ask:done', async () => {
    h.fake.reset();
    const ws = await openWs(h.server.baseUrl);
    const events: ServerEvent[] = [];
    const finished = new Promise<void>((resolve) => {
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerEvent;
        if (msg.type?.startsWith('ask:')) {
          events.push(msg);
          if (msg.type === 'ask:done' || msg.type === 'ask:error') resolve();
        }
      };
    });

    // Kick off the ask only after the socket is listening, so no tokens are missed.
    const res = await h.server.request('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'hi' }),
    });
    // 202 Accepted — the answer streams over /ws, not in this response.
    expect(res.status).toBe(202);

    try {
      await Promise.race([finished, deadline(10_000)]);
    } finally {
      ws.close();
    }

    const tokens = events
      .filter((e): e is Extract<ServerEvent, { type: 'ask:token' }> => e.type === 'ask:token')
      .map((e) => e.text)
      .join('');
    expect(tokens).toBe('Hello world');
    expect(events.some((e) => e.type === 'ask:done')).toBe(true);

    // The server really called the fake LLM.
    expect(h.fake.requests.some((r) => r.service === 'llm')).toBe(true);
  });
});
