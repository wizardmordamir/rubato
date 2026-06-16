/**
 * Heuristic token estimate (chars / 4). Good enough for budgeting context; a real
 * tokenizer can drop in behind this signature later without touching callers.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
