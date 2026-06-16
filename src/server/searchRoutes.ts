/**
 * Universal content search — GET /api/search?q= — one query across the durable,
 * user-authored items (saved commands, board tasks, the curl/regex/cron tools,
 * HTTP requests, DB queries + connections, ServiceNow requests + connections,
 * remediation plans, excel automations, and chat conversations). Transient run
 * output / history is deliberately excluded to keep results signal-dense.
 *
 * The text mechanics (LIKE escaping, match snippets, searching a JSON column's
 * values) come from `cwip/search`, shared with the sibling app — this file owns
 * only the rubato-specific part: which tables/columns to search and where each
 * result links. Single-user + local, so there are no per-user access rules and no
 * secret columns to redact (DB/ServiceNow credentials live in env, not these rows).
 */

import { buildSnippet, firstMatchSnippet, LIKE_ESCAPE, likePattern } from 'cwip/search';
import { getDb } from './db';
import { json, jsonError } from './http';

interface SearchHit {
  id: string;
  title: string;
  snippet?: string;
  /** A short right-aligned tag (a folder, an app, the tool kind). */
  sub?: string;
  href: string;
}

/** A search source: a table, the text/JSON columns to match, and a row→hit mapper.
 *  Several sources can share a `groupKey` (e.g. curl/regex/cron all land in Tools). */
interface Source {
  groupKey: string;
  table: string;
  cols: string[];
  extra?: string;
  map: (row: any, q: string) => SearchHit;
}

const GROUP_ORDER = [
  'commands',
  'board',
  'links',
  'tools',
  'requests',
  'queries',
  'servicenow',
  'plans',
  'excel',
  'chat',
] as const;

const GROUP_META: Record<string, { label: string; href: string }> = {
  commands: { label: 'Commands', href: '/commands' },
  board: { label: 'Board', href: '/board' },
  links: { label: 'Links', href: '/links' },
  tools: { label: 'Tools', href: '/tools' },
  requests: { label: 'Requests', href: '/requests' },
  queries: { label: 'Queries', href: '/queries' },
  servicenow: { label: 'ServiceNow', href: '/servicenow' },
  plans: { label: 'Plans', href: '/plans' },
  excel: { label: 'Excel', href: '/excel' },
  chat: { label: 'Chat', href: '/chat' },
};

const ci = (h: string, n: string) => h.toLowerCase().includes(n.toLowerCase());

// The "why it matched" snippet: nothing when the title already shows the match;
// otherwise the first excerpt from a plain-text field, else from a JSON column's
// values (firstMatchSnippet flattens JSON so the snippet is readable, not raw JSON).
const pickSnippet = (
  title: string,
  q: string,
  texts: (string | null | undefined)[],
  jsons: (string | null | undefined)[] = [],
): string | undefined => {
  if (ci(title, q)) return undefined;
  for (const t of texts) {
    const s = buildSnippet(t ?? '', q);
    if (s) return s;
  }
  for (const j of jsons) {
    const s = firstMatchSnippet(j ?? '', q);
    if (s) return s;
  }
  return undefined;
};

const hit = (groupKey: string, id: string, title: string, snippet?: string, sub?: string): SearchHit => ({
  id: `${groupKey}:${id}`,
  title: title || '(untitled)',
  snippet,
  sub,
  href: GROUP_META[groupKey].href,
});

const SOURCES: Source[] = [
  {
    groupKey: 'commands',
    table: 'saved_commands',
    cols: ['name', 'description', 'command', 'args', 'cwd'],
    map: (r, q) => hit('commands', r.id, r.name, pickSnippet(r.name, q, [r.description, r.command, r.cwd], [r.args])),
  },
  {
    groupKey: 'board',
    table: 'board_tasks',
    cols: ['title', 'task'],
    map: (r, q) => hit('board', r.id, r.title, pickSnippet(r.title, q, [], [r.task])),
  },
  {
    groupKey: 'links',
    table: 'links',
    cols: ['title', 'url', 'description', 'notes', 'folder', 'tags'],
    map: (r, q) =>
      hit(
        'links',
        r.id,
        r.title || r.url,
        pickSnippet(r.title || r.url, q, [r.url, r.description, r.notes, r.folder], [r.tags]),
        r.folder || undefined,
      ),
  },
  {
    groupKey: 'tools',
    table: 'saved_curl_requests',
    cols: ['name', 'request'],
    map: (r, q) => hit('tools', r.id, r.name, pickSnippet(r.name, q, [], [r.request]), 'curl'),
  },
  {
    groupKey: 'tools',
    table: 'saved_regexes',
    cols: ['title', 'pattern', 'notes'],
    map: (r, q) => hit('tools', r.id, r.title, pickSnippet(r.title, q, [r.pattern, r.notes]), 'regex'),
  },
  {
    groupKey: 'tools',
    table: 'saved_crons',
    cols: ['title', 'expression', 'notes'],
    map: (r, q) => hit('tools', r.id, r.title, pickSnippet(r.title, q, [r.expression, r.notes]), 'cron'),
  },
  {
    groupKey: 'requests',
    table: 'http_requests',
    cols: ['name', 'folder', 'request'],
    map: (r, q) =>
      hit('requests', r.id, r.name, pickSnippet(r.name, q, [r.folder], [r.request]), r.folder || undefined),
  },
  {
    groupKey: 'queries',
    table: 'db_saved_queries',
    cols: ['name', 'query'],
    map: (r, q) => hit('queries', r.id, r.name, pickSnippet(r.name, q, [], [r.query])),
  },
  {
    groupKey: 'queries',
    table: 'db_connections',
    cols: ['name', 'connection'],
    map: (r, q) => hit('queries', r.id, r.name, pickSnippet(r.name, q, [], [r.connection]), 'connection'),
  },
  {
    groupKey: 'servicenow',
    table: 'servicenow_requests',
    cols: ['name', 'request'],
    map: (r, q) => hit('servicenow', r.id, r.name, pickSnippet(r.name, q, [], [r.request])),
  },
  {
    groupKey: 'servicenow',
    table: 'servicenow_connections',
    cols: ['name', 'connection'],
    map: (r, q) => hit('servicenow', r.id, r.name, pickSnippet(r.name, q, [], [r.connection]), 'connection'),
  },
  {
    groupKey: 'plans',
    table: 'remediation_plans',
    cols: ['title', 'app', 'source', 'content'],
    map: (r, q) => hit('plans', r.id, r.title, pickSnippet(r.title, q, [r.content, r.source]), r.app || undefined),
  },
  {
    groupKey: 'excel',
    table: 'excel_automations',
    cols: ['name', 'description', 'source_name', 'steps_json'],
    extra: 'AND archived = 0',
    map: (r, q) =>
      hit(
        'excel',
        r.id,
        r.name,
        pickSnippet(r.name, q, [r.description, r.source_name], [r.steps_json]),
        r.source_name || undefined,
      ),
  },
  {
    groupKey: 'chat',
    table: 'conversations',
    cols: ['title', 'app'],
    map: (r, q) => hit('chat', r.id, r.title, pickSnippet(r.title, q, [r.app]), r.app || undefined),
  },
];

const PER_SOURCE = 8;

export function handleSearchApi(pathname: string, req: Request): Response {
  if (pathname !== '/api/search') return jsonError(`not found: ${pathname}`, 404);
  if (req.method !== 'GET') return jsonError('use GET', 405);

  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (!q) return json({ groups: [] });

  const db = getDb();
  const pattern = likePattern(q);

  const buckets = new Map<string, SearchHit[]>();
  for (const s of SOURCES) {
    const where = s.cols.map((c) => `${c} LIKE ? ESCAPE '${LIKE_ESCAPE}'`).join(' OR ');
    const sql = `SELECT * FROM ${s.table} WHERE (${where}) ${s.extra ?? ''} ORDER BY updated_at DESC LIMIT ${PER_SOURCE}`;
    const rows = db.query(sql).all(...s.cols.map(() => pattern)) as any[];
    if (!rows.length) continue;
    const hits = rows.map((r) => s.map(r, q));
    const cur = buckets.get(s.groupKey);
    if (cur) cur.push(...hits);
    else buckets.set(s.groupKey, hits);
  }

  const groups = GROUP_ORDER.filter((k) => buckets.has(k)).map((k) => ({
    key: k,
    label: GROUP_META[k].label,
    href: GROUP_META[k].href,
    items: (buckets.get(k) ?? []).slice(0, PER_SOURCE),
  }));

  return json({ groups });
}
