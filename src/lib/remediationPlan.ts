/**
 * Pure core for AI remediation-plan generation (pipelines use-cases 1 + 3):
 * turn vulnerability data and/or attached scan reports into a Markdown remediation
 * plan. The LLM call is injected (`AiComplete`) so this is fully unit-testable with
 * a fake and the server wires in the real provider via `llmFromConfig`/`completeText`.
 */

import type { LlmMessage } from '../api/llm/types';

export interface PlanInput {
  /** A title/label for the plan (UI + storage). */
  title?: string;
  /** Optional app this plan is about. */
  app?: string;
  /** Structured vulnerability data (e.g. computeVulnStats / appscan-pdf JSON). */
  data?: unknown;
  /** Raw text from attached scan files (already extracted, e.g. via extractPdfText). */
  files?: { name: string; text: string }[];
  /** Extra steering instructions. */
  instructions?: string;
}

export const PLAN_SYSTEM =
  'You are a security remediation assistant. Given vulnerability scan data and reports, ' +
  'produce a clear, actionable remediation PLAN as GitHub-flavored Markdown ONLY — no preamble ' +
  'and do not wrap the whole document in a code fence. Start with a short summary, then ' +
  'prioritized sections (Critical → High → Medium → Low); for each issue give the affected ' +
  'apps/components and concrete, practical remediation steps.';

/** Per-file text budget so a few large reports can't blow the prompt. */
export const MAX_FILE_CHARS = 20_000;

export function buildPlanPrompt(input: PlanInput): LlmMessage[] {
  const parts: string[] = [];
  if (input.title) parts.push(`Plan title: ${input.title}`);
  if (input.app) parts.push(`Application: ${input.app}`);
  if (input.instructions) parts.push(`Additional instructions: ${input.instructions}`);
  if (input.data !== undefined) {
    parts.push(`## Vulnerability data (JSON)\n\`\`\`json\n${JSON.stringify(input.data, null, 2)}\n\`\`\``);
  }
  for (const f of input.files ?? []) {
    const text = f.text.length > MAX_FILE_CHARS ? `${f.text.slice(0, MAX_FILE_CHARS)}\n…(truncated)` : f.text;
    parts.push(`## Attached report: ${f.name}\n${text}`);
  }
  if (parts.length === 0) parts.push('(no data provided — produce a generic remediation checklist)');
  parts.push('Produce the remediation plan now as Markdown.');
  return [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** Drop an accidental ```markdown fence wrapping the WHOLE document (models love to add one). */
export function stripOuterFence(md: string): string {
  const m = md.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : md.trim();
}

/** Build a default plan title from inputs when the caller didn't give one. */
export function defaultPlanTitle(input: PlanInput): string {
  if (input.title?.trim()) return input.title.trim();
  if (input.app?.trim()) return `Remediation plan — ${input.app.trim()}`;
  return 'Remediation plan';
}

export type AiComplete = (messages: LlmMessage[]) => Promise<string>;

/** Generate the Markdown plan via the injected LLM. Throws if the model errors. */
export async function generatePlan(ai: AiComplete, input: PlanInput): Promise<string> {
  const raw = await ai(buildPlanPrompt(input));
  const md = stripOuterFence(raw);
  if (!md) throw new Error('The model returned an empty plan');
  return md;
}
