/**
 * Splunk API: surface the apps that carry a `splunk` config, assemble a query
 * string from form inputs, and — for users who've configured Splunk keys —
 * execute it and return the result rows.
 *
 *   GET  /api/splunk/apps   → SplunkAppInfo[] (apps + their envs/saved searches)
 *   GET  /api/splunk/status → { configured, defaults } (SPLUNK_URL+TOKEN set? + globals)
 *   POST /api/splunk/query  → { query, missing } from SplunkQueryRequest (build only)
 *   POST /api/splunk/run    → { query, fields, rows, count } (build + execute)
 *
 * Building is pure string work; running needs keys and is gated behind /status.
 * An app is optional: omit it for a **custom** query unrelated to any configured
 * app — the builder then runs on global defaults + the inline form inputs alone.
 */

import { ApiError } from '../api/client';
import { splunkConfigured, splunkFromConfig } from '../api/splunk/client';
import { buildSplunkQuery } from '../api/splunk/queryBuilder';
import type { SplunkAppApi } from '../lib/appApis';
import { type AppConfig, findMatches, getAppApi, loadApps } from '../lib/apps';
import { loadConfig } from '../lib/config';
import type {
  SplunkAppInfo,
  SplunkQueryRequest,
  SplunkQueryResponse,
  SplunkRunRequest,
  SplunkRunResponse,
  SplunkStatus,
} from '../shared/types';
import { json, jsonError } from './http';

/** Resolve the app + its splunk config from a request body, or an error Response. */
async function resolveSplunkApp(name: string): Promise<{ app: AppConfig; splunk: SplunkAppApi } | Response> {
  const apps = await loadApps();
  const app = apps.find((a) => a.name === name) ?? findMatches(name, apps)[0] ?? null;
  if (!app) return jsonError(`unknown app: ${name}`, 404);
  const splunk = getAppApi(app, 'splunk');
  if (!splunk) return jsonError(`app "${app.name}" has no splunk config`, 400);
  return { app, splunk };
}

/**
 * Build the query string for a request, applying the same precedence everywhere.
 * `resolved` is the registered app + its splunk config; when omitted (a custom,
 * app-less query) the builder runs on an empty config + global defaults, and
 * `${app}` comes from the request's `appId`.
 */
async function buildForRequest(body: SplunkQueryRequest, resolved?: { app: AppConfig; splunk: SplunkAppApi }) {
  const cfg = await loadConfig();
  const splunk: SplunkAppApi = resolved?.splunk ?? { name: 'splunk' };
  const appVar = resolved ? (resolved.splunk.appId ?? resolved.app.dirName) : body.appId;
  return buildSplunkQuery(splunk, {
    env: body.env,
    search: body.search,
    index: body.index,
    domain: body.domain,
    fragment: body.fragment,
    extra: body.extra,
    vars: body.vars,
    app: appVar,
    defaults: cfg.splunk?.defaults,
  });
}

export async function handleSplunkApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/splunk/apps') {
    const [apps, cfg] = await Promise.all([loadApps(), loadConfig()]);
    const defaults = cfg.splunk?.defaults;
    const out: SplunkAppInfo[] = [];
    for (const app of apps) {
      const splunk = getAppApi(app, 'splunk');
      if (!splunk) continue;
      out.push({
        app: app.name,
        appId: splunk.appId ?? app.dirName,
        index: splunk.index ?? defaults?.index,
        envs: splunk.envs ?? defaults?.envs ?? [],
        searches: (splunk.searches ?? []).map((s) => ({ label: s.label, search: s.search })),
      });
    }
    return json(out);
  }

  if (pathname === '/api/splunk/status') {
    const cfg = await loadConfig();
    const d = cfg.splunk?.defaults;
    const res: SplunkStatus = {
      configured: await splunkConfigured(),
      defaults: d ? { index: d.index, domain: d.domain, envs: d.envs } : undefined,
    };
    return json(res);
  }

  if (pathname === '/api/splunk/query') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    let body: SplunkQueryRequest;
    try {
      body = (await req.json()) as SplunkQueryRequest;
    } catch {
      return jsonError('invalid JSON body', 400);
    }
    let resolved: { app: AppConfig; splunk: SplunkAppApi } | undefined;
    if (body.app) {
      const r = await resolveSplunkApp(body.app);
      if (r instanceof Response) return r;
      resolved = r;
    }
    const { query, missing } = await buildForRequest(body, resolved);
    const res: SplunkQueryResponse = { query, missing };
    return json(res);
  }

  if (pathname === '/api/splunk/run') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    let body: SplunkRunRequest;
    try {
      body = (await req.json()) as SplunkRunRequest;
    } catch {
      return jsonError('invalid JSON body', 400);
    }
    let resolved: { app: AppConfig; splunk: SplunkAppApi } | undefined;
    if (body.app) {
      const r = await resolveSplunkApp(body.app);
      if (r instanceof Response) return r;
      resolved = r;
    }

    const { query, missing } = await buildForRequest(body, resolved);
    // Refuse to run an incomplete query — interpolation gaps would scan the wrong domain.
    if (missing.length) return jsonError(`fill in: ${missing.join(', ')}`, 400, { missing });

    try {
      const client = await splunkFromConfig();
      const result = await client.runSearch(query, {
        earliest: body.earliest,
        latest: body.latest,
        count: body.count,
      });
      const res: SplunkRunResponse = { query, fields: result.fields, rows: result.rows, count: result.count };
      return json(res);
    } catch (err) {
      // ApiError (auth/network) → 502; missing keys / Splunk errors → 400.
      const status = err instanceof ApiError ? 502 : 400;
      return jsonError(err instanceof Error ? err.message : 'splunk run failed', status);
    }
  }

  return jsonError(`not found: ${pathname}`, 404);
}
