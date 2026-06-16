/**
 * User-defined tools, loaded from ~/.rubato/tools/*.json (one tool per file,
 * like automations). The first type is `http`: a templated request to an API in
 * the environment, so the agent can pull *live* data — e.g. an app's own API —
 * not just read its source. Templates interpolate `${param}` / `${params.x}`,
 * `${env.NAME}` (secrets from ~/.rubato/.env, redacted in output), `${app.name}`
 * / `${app.dir}`, and `${api.<name>.baseUrl}` resolved from the app's `apis`
 * config (or the global service default). Tools can be scoped to one app.
 *
 * This is intentionally a small v1 — the JSON shape is meant to grow, not be
 * locked down. Read-only by convention; no shell, no file writes.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { logger } from 'cwip';
import { optionalEnv } from '../../api/env';
import type { ToolParam } from '../../lib/ai/toolProtocol';
import { fillTemplate, redactSecrets } from '../../lib/ai/toolTemplate';
import type { AppConfig } from '../../lib/apps';
import { RUBATO_HOME, type RubatoConfig } from '../../lib/config';
import type { RepoTool, ToolContext, ToolResult } from './types';

const TOOLS_DIR = resolve(RUBATO_HOME, 'tools');
const MAX_RESPONSE_CHARS = 4000;
const TIMEOUT_MS = 15_000;

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface UserToolDef {
  name: string;
  description: string;
  type: 'http';
  params?: ToolParam[];
  /** Restrict to one app by name/alias/group/dir; omit to offer it for every app. */
  appScope?: string;
  request: {
    method?: HttpMethod;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
}

/** A structural subset of `fetch`, so tests can inject a fake transport. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** `api.<name>.baseUrl` for each of the app's configured APIs (entry or global default). */
function apiBaseUrls(app: AppConfig, cfg: RubatoConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const api of app.apis ?? []) {
    const fromEntry = (api as { baseUrl?: string }).baseUrl;
    const fromGlobal = (cfg as unknown as Record<string, { baseUrl?: string } | undefined>)[api.name]?.baseUrl;
    const base = fromEntry ?? fromGlobal;
    if (base) out[`api.${api.name}.baseUrl`] = base;
  }
  return out;
}

/** Build the template resolver for one call; tracks resolved secrets for redaction. */
function makeResolver(app: AppConfig, cfg: RubatoConfig, params: Record<string, unknown>) {
  const bases = apiBaseUrls(app, cfg);
  const secrets = new Set<string>();
  const resolve = (key: string): string | undefined => {
    if (key.startsWith('env.')) {
      const v = optionalEnv(key.slice(4));
      if (v) secrets.add(v);
      return v;
    }
    if (key.startsWith('api.')) return bases[key];
    if (key === 'app.name') return app.name;
    if (key === 'app.dir') return app.absolutePath;
    const name = key.startsWith('params.') ? key.slice(7) : key;
    const raw = params[name];
    return raw === undefined ? undefined : String(raw);
  };
  return { resolve, secrets };
}

/** Turn one `http` tool def into a runnable RepoTool. */
export function buildHttpTool(def: UserToolDef, cfg: RubatoConfig, fetchImpl: FetchLike = fetch): RepoTool {
  return {
    spec: { name: def.name, description: def.description, params: def.params ?? [] },
    async run({ app }: ToolContext, params): Promise<ToolResult> {
      if (!app) return { ok: false, content: `${def.name} needs an app context` };
      const { resolve: resolveKey, secrets } = makeResolver(app, cfg, params);
      const show = (s: string) => redactSecrets(s, secrets);
      const method = def.request.method ?? 'GET';
      const url = fillTemplate(def.request.url, resolveKey);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(def.request.headers ?? {})) headers[k] = fillTemplate(v, resolveKey);
      let body: string | undefined;
      if (method !== 'GET' && def.request.body !== undefined) {
        const raw = typeof def.request.body === 'string' ? def.request.body : JSON.stringify(def.request.body);
        body = fillTemplate(raw, resolveKey);
        if (!('content-type' in headers)) headers['content-type'] = 'application/json';
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal });
        const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
        return { ok: res.ok, content: `${method} ${show(url)}\n→ HTTP ${res.status}\n${show(text)}` };
      } catch (err) {
        return { ok: false, content: `request failed: ${show(err instanceof Error ? err.message : String(err))}` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function isValidDef(d: unknown): d is UserToolDef {
  if (typeof d !== 'object' || d === null) return false;
  const o = d as Record<string, unknown>;
  const req = o.request as Record<string, unknown> | undefined;
  return (
    typeof o.name === 'string' &&
    /^[a-z0-9_]+$/i.test(o.name) &&
    typeof o.description === 'string' &&
    o.type === 'http' &&
    typeof req === 'object' &&
    req !== null &&
    typeof req.url === 'string'
  );
}

/** Read + validate tool defs from a directory (default ~/.rubato/tools). */
export async function loadUserToolDefs(dir = TOOLS_DIR): Promise<UserToolDef[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return []; // no tools dir → none
  }
  const defs: UserToolDef[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(resolve(dir, name), 'utf8'));
      if (isValidDef(parsed)) defs.push(parsed);
      else logger.warn(`[tools] skipping invalid tool def: ${name}`);
    } catch {
      logger.warn(`[tools] could not read tool def: ${name}`);
    }
  }
  return defs;
}

/** Whether a (possibly app-scoped) tool def applies to this app. */
export function appliesToApp(def: UserToolDef, app: AppConfig): boolean {
  if (!def.appScope) return true;
  const want = def.appScope.toLowerCase();
  return [app.name, app.group, app.dirName, ...(app.aliases ?? [])]
    .filter((v): v is string => typeof v === 'string')
    .some((v) => v.toLowerCase() === want);
}

/** All user tools applicable to an app, built and ready to run. */
export async function loadUserTools(app: AppConfig, cfg: RubatoConfig): Promise<RepoTool[]> {
  const defs = (await loadUserToolDefs()).filter((d) => appliesToApp(d, app));
  return defs.map((d) => buildHttpTool(d, cfg));
}
