/**
 * Optional LLM-backed tier classifier for the drainer's autoTierEligibleAsync
 * pre-sweep. Uses the Anthropic API (claude-haiku) to refine AMBIGUOUS tasks —
 * those where the pure heuristic found no keyword signal — with one cheap call.
 * Opt-in: returns null when ANTHROPIC_API_KEY is absent, so the caller can skip
 * the pre-sweep entirely and fall back to the conservative heuristic default.
 */

import type { AsyncTierClassifier, TierVerdict } from 'cwip/taskq';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';

const CLASSIFY_PROMPT = `You are a task complexity classifier. Classify this software development task into one of two tiers based on its likely complexity and risk:

- "opus": complex, architectural, risky, or open-ended work (e.g. designing systems, security changes, engine work, multi-file refactors, anything that could go wrong in subtle ways)
- "sonnet": mechanical, routine, or well-scoped work (e.g. small fixes, config tweaks, adding a field, writing tests for existing code, simple UI changes)

Reply with exactly one word: "opus" or "sonnet". No explanation.`;

interface AnthropicContent {
  type: string;
  text?: string;
}
interface AnthropicResponse {
  content?: AnthropicContent[];
}

/**
 * Build an async tier classifier backed by the Claude Haiku API. Returns null
 * when ANTHROPIC_API_KEY is absent so callers skip the pre-sweep entirely.
 * All API errors and unexpected responses silently return null — the heuristic
 * conservative default (opus/high) is always the fallback.
 */
export function makeLlmTierClassifier(): AsyncTierClassifier | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  return async (title: string, body: string | null): Promise<TierVerdict | null> => {
    const taskText = body ? `Title: ${title}\nBody: ${body}` : `Title: ${title}`;
    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLASSIFY_MODEL,
          max_tokens: 10,
          messages: [{ role: 'user', content: `${CLASSIFY_PROMPT}\n\nTask:\n${taskText}` }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as AnthropicResponse;
      const text = json.content
        ?.find((c) => c.type === 'text')
        ?.text?.trim()
        .toLowerCase();
      if (text === 'sonnet') {
        return { model: 'sonnet', think: 'medium', confidence: 'heuristic', reason: 'LLM: routine/mechanical' };
      }
      if (text === 'opus') {
        return { model: 'opus', think: 'high', confidence: 'heuristic', reason: 'LLM: complex/risky' };
      }
      return null; // unexpected response → heuristic default
    } catch {
      return null; // network/timeout/parse failure → heuristic default
    }
  };
}
