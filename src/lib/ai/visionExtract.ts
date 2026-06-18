/**
 * Step 1 of the vision→code pipeline: hand screenshot(s) to a local vision model
 * and get back a clean markdown diagnostic (OCR'd text, error blocks, layout/
 * alignment issues). That diagnostic is then injected as a `[UI Vision Reference]`
 * context block so the pure-text code model (Step 2) can act on it through the
 * normal RAG + code-check + self-repair loop — the vision model never writes code.
 *
 * Vision requires the native Ollama transport (`flavor: "ollama"`); the diagnostic
 * call passes `images` on the user message, which only that transport forwards.
 */

import { completeText } from '../../api/llm/complete';
import type { LlmMessage, LlmProvider } from '../../api/llm/types';

/** Default local vision model (overridable via `ai.visionModel`). */
export const DEFAULT_VISION_MODEL = 'qwen3-vl:8b';

const VISION_SYSTEM =
  'You are a UI diagnostic vision assistant. You are given one or more screenshots of a web app — ' +
  'possibly showing a bug, a layout problem, or an error. Produce a CONCISE markdown diagnostic using ' +
  'only these sections, and omit any that do not apply:\n' +
  '## Extracted text\nVerbatim visible text, labels, and values (OCR), grouped by region.\n' +
  '## Errors\nAny error messages, stack traces, or console/network errors shown, quoted exactly.\n' +
  '## Layout & alignment issues\nVisual problems: misalignment, overlap, clipping, spacing, contrast, broken or missing elements.\n' +
  '## Notable UI structure\nKey components/sections visible and how they are arranged.\n\n' +
  'Report ONLY what is visible in the image(s). Do not guess at source code and do not propose fixes — a later step does that.';

/**
 * Run the vision model over `images` and return its markdown diagnostic (trimmed).
 * Throws on provider error (the caller decides whether to degrade gracefully).
 */
export async function extractVisionDiagnostic(
  provider: LlmProvider,
  images: string[],
  question: string,
  opts: { model: string; signal?: AbortSignal },
): Promise<string> {
  const messages: LlmMessage[] = [
    { role: 'system', content: VISION_SYSTEM },
    {
      role: 'user',
      content: `User request: ${question}\n\nAnalyze the attached screenshot(s) and produce the diagnostic.`,
      images,
    },
  ];
  const text = await completeText(provider, messages, { model: opts.model, signal: opts.signal });
  return text.trim();
}
