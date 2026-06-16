/**
 * Pure Automation → Automation transforms — the "make a recorded flow fit a
 * different app" layer that runs *before* codegen (src/lib/exportSpec.ts).
 *
 * A flow recorded in the rubato UI captures whatever host it was driven against
 * (a staging URL, a live site, localhost:1234). An e2e suite usually runs against
 * a *different* base — its own webServer / `use.baseURL`. `rebaseAutomationUrls`
 * rewrites the recorded navigations so they resolve against the consumer's base
 * instead, without touching anything else about the automation. It's a plain
 * value-in/value-out function so the work is obvious and testable.
 */

import type { Automation, Step } from '../../shared/automation';

export interface RebaseUrlOptions {
  /**
   * Recorded origin(s) to rewrite, e.g. "https://chat.staging.example.com".
   * Omit to default to the origin of the automation's `startUrl` — the common
   * case ("strip wherever I recorded this and make it relative").
   */
  from?: string | string[];
  /**
   * Replacement base. "" (default) makes navigations *relative paths* (`/login`)
   * so Playwright resolves them against `use.baseURL` from the consumer's config.
   * Pass an origin (e.g. "http://localhost:5080") to rebase onto that host instead.
   */
  to?: string;
}

/** Add a scheme so a bare host like "example.com/x" parses as a URL. */
function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

/** The origin ("https://host:port") of a (possibly scheme-less) URL, or null. */
function originOf(url: string): string | null {
  try {
    return new URL(withScheme(url)).origin;
  } catch {
    return null;
  }
}

/**
 * Rewrite one URL: if its origin is in `fromOrigins`, replace that origin with
 * `to` (or drop it for a relative path). Anything else — a different host, or a
 * value carrying `${VAR}` interpolation we can't safely parse — is left as-is.
 */
function rebaseUrl(url: string, fromOrigins: Set<string>, to: string): string {
  if (url.includes('${')) return url; // interpolated — don't risk mangling it
  let parsed: URL;
  try {
    parsed = new URL(withScheme(url));
  } catch {
    return url;
  }
  if (!fromOrigins.has(parsed.origin)) return url;
  const rel = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return to ? `${to.replace(/\/+$/, '')}${rel}` : rel;
}

/** Recurse a step tree, rewriting every navigation (`goto`/`newTab`) URL in place. */
function rebaseSteps(steps: Step[], fromOrigins: Set<string>, to: string): Step[] {
  return steps.map((step) => {
    const next: Step = { ...step };
    if ((step.action === 'goto' || step.action === 'newTab') && step.params?.url) {
      next.params = { ...step.params, url: rebaseUrl(step.params.url, fromOrigins, to) };
    }
    if (step.thenSteps) next.thenSteps = rebaseSteps(step.thenSteps, fromOrigins, to);
    if (step.elseSteps) next.elseSteps = rebaseSteps(step.elseSteps, fromOrigins, to);
    return next;
  });
}

/**
 * Return a copy of `automation` with its `startUrl` and every navigation
 * (`goto`/`newTab`) rebased off the recorded origin(s). Leaves selectors, fills, assertions, and
 * `expectUrl` matchers untouched (a substring/regex URL assertion keeps working
 * against the new base). Pure: the input is not mutated.
 */
export function rebaseAutomationUrls(automation: Automation, opts: RebaseUrlOptions = {}): Automation {
  const to = opts.to ?? '';
  const fromList = opts.from
    ? Array.isArray(opts.from)
      ? opts.from
      : [opts.from]
    : automation.startUrl
      ? [automation.startUrl]
      : [];
  const fromOrigins = new Set<string>();
  for (const f of fromList) {
    const o = originOf(f);
    if (o) fromOrigins.add(o);
  }

  return {
    ...automation,
    startUrl: automation.startUrl ? rebaseUrl(automation.startUrl, fromOrigins, to) : automation.startUrl,
    steps: rebaseSteps(automation.steps, fromOrigins, to),
  };
}
