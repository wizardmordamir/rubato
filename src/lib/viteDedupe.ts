/**
 * Vite `resolve.dedupe` completeness guardrail — the static anti-WHITE-SCREEN check.
 *
 * When an app and a first-party dep (cwip / cursedbelt) each ship React under their own
 * `node_modules`, Vite will bundle TWO React copies unless every React entry point is in
 * `resolve.dedupe`. Two Reacts means hooks read a null dispatcher → the app white-screens.
 * The trap: it's PER-SUBPATH. Dedupe `react` + `react-dom` but forget `react/jsx-dev-runtime`
 * and the build still passes and prod still works — but DEV white-screens (dev compiles JSX
 * via `jsx-dev-runtime`, prod via `jsx-runtime`), which a prod-bundle render smoke can't see.
 * So this pure check asserts the FULL React subpath set is present, catching the gap that
 * only manifests at dev runtime.
 *
 * Pure + dependency-free so it's trivially unit-testable AND reusable by the cross-repo
 * anti-drift guardrails (`fu-guardrails-enforce` in cursedbelt) — feed it any app's parsed
 * dedupe array. {@link extractDedupeFromSource} turns a `vite.config.ts` source string into
 * that array so a guardrail can read each app's config off disk.
 */

/**
 * The React entry points whose absence from `resolve.dedupe` silently white-screens (a
 * second React copy → null hook dispatcher). Every one of these MUST be deduped. Missing
 * `jsx-dev-runtime` in particular white-screens ONLY in dev, so a build/prod smoke misses it.
 */
export const REQUIRED_REACT_DEDUPE: readonly string[] = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
];

/**
 * Other context-bearing libs that SHOULD be deduped: a duplicate copy breaks that library's
 * React context (e.g. cwip's `useApiMutation` can't see the app's QueryClientProvider) rather
 * than white-screening the whole app — so these WARN rather than fail. Apps may extend this
 * (recharts, lucide-react, etc.); the guardrail only asserts the always-required React set.
 */
export const RECOMMENDED_CONTEXT_DEDUPE: readonly string[] = ['@tanstack/react-query', 'zustand'];

/** Result of checking a `resolve.dedupe` array for completeness. */
export interface DedupeCheck {
  /** True iff EVERY {@link REQUIRED_REACT_DEDUPE} entry is present (the hard gate). */
  ok: boolean;
  /** Required React subpaths absent from the dedupe list (each one a white-screen risk). */
  missingRequired: string[];
  /** Recommended context libs absent (a soft warning, not a failure). */
  missingRecommended: string[];
}

/**
 * PURE: check a parsed `resolve.dedupe` array against the required React set (hard) and the
 * recommended context-lib set (soft). Pass `recommended` to tailor the soft set per app.
 */
export function checkReactDedupe(
  dedupe: readonly string[] | null | undefined,
  recommended: readonly string[] = RECOMMENDED_CONTEXT_DEDUPE,
): DedupeCheck {
  const have = new Set(dedupe ?? []);
  const missingRequired = REQUIRED_REACT_DEDUPE.filter((r) => !have.has(r));
  const missingRecommended = recommended.filter((r) => !have.has(r));
  return { ok: missingRequired.length === 0, missingRequired, missingRecommended };
}

/**
 * PURE: extract the FIRST `resolve.dedupe` array's string entries from a `vite.config.ts`
 * source. Returns `null` when no `dedupe: [ … ]` block is found (so the caller can flag a
 * config that doesn't dedupe at all, distinct from one that dedupes an empty list). Handles
 * the common shape — a `dedupe:` key followed by an array of single/double-quoted strings,
 * with comments interleaved — which is all our configs use.
 */
export function extractDedupeFromSource(source: string): string[] | null {
  const m = source.match(/dedupe\s*:\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  const body = m[1];
  const entries: string[] = [];
  const re = /['"]([^'"]+)['"]/g;
  let hit: RegExpExecArray | null = re.exec(body);
  while (hit !== null) {
    entries.push(hit[1]);
    hit = re.exec(body);
  }
  return entries;
}

/** Convenience: parse a config source and check it in one call. */
export function checkDedupeSource(
  source: string,
  recommended: readonly string[] = RECOMMENDED_CONTEXT_DEDUPE,
): DedupeCheck & { found: boolean } {
  const dedupe = extractDedupeFromSource(source);
  return { found: dedupe !== null, ...checkReactDedupe(dedupe, recommended) };
}

/** A one-line human summary of a {@link DedupeCheck} (for guardrail/CLI output). */
export function formatDedupeCheck(label: string, check: DedupeCheck): string {
  if (check.ok && check.missingRecommended.length === 0) return `✓ ${label}: dedupe complete`;
  const parts: string[] = [];
  if (check.missingRequired.length > 0)
    parts.push(`MISSING REQUIRED (white-screen risk): ${check.missingRequired.join(', ')}`);
  if (check.missingRecommended.length > 0) parts.push(`missing recommended: ${check.missingRecommended.join(', ')}`);
  return `${check.ok ? '⚠' : '✗'} ${label}: ${parts.join(' · ')}`;
}
