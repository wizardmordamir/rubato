/**
 * Pure Splunk query builder — turns an app's Splunk config plus a few form
 * inputs into a ready-to-paste search string. No network, no Bun/Node deps, so
 * it's trivially testable.
 *
 * A Splunk search like
 *
 *     index=main dom IN("my-app-prod") /api/v*\/audit
 *
 * is really a template with a few variable slots: the index (log source), the
 * domain filter (conventionally `${app}-${env}`), and a trailing search fragment
 * (a path or SPL). This assembles those slots with a clear precedence —
 *
 *     per-call option  >  saved-search template  >  per-app config  >  global default
 *
 * — interpolating `${app}`/`${env}`/`${custom}` and reporting any referenced
 * variable that had no value, so the UI can flag an incomplete query.
 */

import type { SplunkAppApi, SplunkDefaults, SplunkSearch } from '../../lib/appApis';

/** Domain pattern used when nothing configures one. */
export const DEFAULT_DOMAIN_PATTERN = '${app}-${env}';
/** How the domain filter wraps the resolved domain when nothing overrides it. */
export const DEFAULT_DOMAIN_CLAUSE = 'dom IN("${domain}")';

export interface BuildQueryOptions {
  /** Target environment, e.g. "prod" (fills `${env}`). */
  env?: string;
  /** Label of a saved search template to start from. */
  search?: string;
  /** Override the index (log source). */
  index?: string;
  /** Override the domain pattern. */
  domain?: string;
  /** Override the trailing search fragment (path/SPL); replaces the template's. */
  fragment?: string;
  /** Extra free-text terms appended verbatim to the end of the query. */
  extra?: string;
  /** Value for `${app}`; defaults to the app's `appId`. */
  app?: string;
  /** Extra interpolation variables, referenced as `${name}`. */
  vars?: Record<string, string>;
  /** Global Splunk defaults (from config.splunk.defaults). */
  defaults?: SplunkDefaults;
}

export interface BuildQueryResult {
  /** The assembled Splunk query string. */
  query: string;
  /** Variables referenced in a template but left without a value (e.g. ["env"]). */
  missing: string[];
  /** The resolved pieces, handy for display/debugging. */
  parts: { index?: string; domain?: string; fragment?: string; extra?: string };
}

/** Find a saved search by label, case-insensitively. */
export function findSearch(app: SplunkAppApi, label?: string): SplunkSearch | undefined {
  if (!label) return undefined;
  const lower = label.toLowerCase();
  return app.searches?.find((s) => s.label.toLowerCase() === lower);
}

/** Replace `${name}` tokens from `vars`; record names that resolve to nothing in `missing`. */
function interpolate(template: string, vars: Record<string, string | undefined>, missing: Set<string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined || v === '') {
      missing.add(name);
      return '';
    }
    return v;
  });
}

/**
 * Build a Splunk query for an app from its config + form inputs. The `app`
 * option supplies `${app}` (the route passes the app's configured `appId` or its
 * directory name); the pure builder itself never reaches for the app registry.
 */
export function buildSplunkQuery(app: SplunkAppApi, opts: BuildQueryOptions = {}): BuildQueryResult {
  const search = findSearch(app, opts.search);
  const defaults = opts.defaults;

  const index = opts.index ?? search?.index ?? app.index ?? defaults?.index;
  const domainPattern = opts.domain ?? search?.domain ?? app.domain ?? defaults?.domain ?? DEFAULT_DOMAIN_PATTERN;
  const fragmentTpl = opts.fragment ?? search?.search ?? '';
  const domainClause = defaults?.domainClause ?? DEFAULT_DOMAIN_CLAUSE;

  const vars: Record<string, string | undefined> = { app: opts.app ?? app.appId, env: opts.env, ...opts.vars };
  const missing = new Set<string>();

  const domain = domainPattern.trim() ? interpolate(domainPattern, vars, missing).trim() : '';
  const fragment = fragmentTpl.trim() ? interpolate(fragmentTpl, vars, missing).trim() : '';
  const extra = opts.extra?.trim() ?? '';

  const segments: string[] = [];
  if (index) segments.push(`index=${index}`);
  if (domain) segments.push(interpolate(domainClause, { ...vars, domain }, missing).trim());
  if (fragment) segments.push(fragment);
  if (extra) segments.push(extra);

  return {
    query: segments.join(' ').replace(/\s+/g, ' ').trim(),
    missing: [...missing],
    parts: { index, domain: domain || undefined, fragment: fragment || undefined, extra: extra || undefined },
  };
}
