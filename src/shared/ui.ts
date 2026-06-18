/**
 * Web-UI page registry + enablement, shared between the rubato server and the UI.
 * Pure data/types only (no runtime imports) so the UI can import it via the
 * `@shared` Vite alias without pulling in Bun/Node code.
 *
 * Each main-nav page is individually toggle-able (config `ui.pages.<key>`); the
 * defaults are off for everything except `apps`/`excel` and the Docs hub, so the
 * rest are opt-in from Settings → Pages. The sidebar groups pages: a handful are
 * top-level entries and the rest live inside the category hubs (`NAV_HUBS`/
 * `SIDEBAR`). Per-entry
 * color, show/hide, and order are user prefs kept in the browser (see the UI's
 * `navPrefs`), NOT here. The Admin page is gated by `ui.admin` and is deliberately
 * *not* UI-toggle-discoverable — enable it by hand in `~/.rubato/config.json`
 * (`{"ui":{"admin":true}}`).
 */

/**
 * Which sidebar group a page belongs to. `'top'` = the page is its own sidebar
 * entry; the four hub keys = the page is a tile inside that hub's landing page.
 */
export type NavGroup = 'top' | 'data' | 'automation' | 'results' | 'security' | 'docs';

/** One toggle-able web-UI page: a stable key, its route, and its nav label. */
export interface UiPage {
  /** Stable config key (`ui.pages.<key>`). */
  key: string;
  /** Router path. */
  path: string;
  /** Sidebar / hub-tile label. */
  label: string;
  /** Sidebar group: `'top'` for a standalone entry, else the owning hub's key. */
  group: NavGroup;
  /** One-line blurb shown on the hub tile. */
  description?: string;
  /**
   * If set, this page has been merged into the page with this key and is reached
   * as a tab there — it is NOT shown as its own sidebar entry or hub tile, and its
   * old route redirects into the parent (see App.tsx). Its `ui.pages.<key>` toggle
   * still counts toward the parent's visibility (see `resolvePages`).
   */
  mergedInto?: string;
  /** Default accent color (hex) for the sidebar entry. Overridable in Settings. */
  color?: string;
}

/**
 * The toggle-able main-nav pages, in display order. Keep in sync with App.tsx
 * routes. `group` buckets each page into a hub (or `'top'`); `mergedInto` marks
 * the three same-topic pages folded into a tabbed parent.
 */
export const UI_PAGES: UiPage[] = [
  { key: 'apps', path: '/', label: 'Apps', group: 'top', description: 'Your registered code repos and their status.' },
  {
    key: 'dashboard',
    path: '/dashboard',
    label: 'Dashboard',
    group: 'top',
    description: 'Cross-app git and deploy overview.',
  },
  // ── Data hub ──────────────────────────────────────────────────────────────
  { key: 'queries', path: '/queries', label: 'Queries', group: 'data', description: 'SQL and MongoDB query builder.' },
  { key: 'splunk', path: '/splunk', label: 'Splunk', group: 'data', description: 'Build and run Splunk searches.' },
  {
    key: 'servicenow',
    path: '/servicenow',
    label: 'ServiceNow',
    group: 'data',
    description: 'ServiceNow Table API and passthrough.',
  },
  {
    key: 'session',
    path: '/session',
    label: 'Session',
    group: 'data',
    description: 'Rally session and task tracking.',
  },
  {
    key: 'requests',
    path: '/requests',
    label: 'Requests',
    group: 'data',
    description: 'HTTP and saved REST service requests.',
  },
  { key: 'services', path: '/services', label: 'Services', group: 'data', mergedInto: 'requests' },
  // ── Automation hub ────────────────────────────────────────────────────────
  {
    key: 'commands',
    path: '/commands',
    label: 'Commands',
    group: 'automation',
    description: 'Saved shell commands and builtins.',
  },
  {
    key: 'scripts',
    path: '/scripts',
    label: 'Scripts',
    group: 'automation',
    description: 'Custom TypeScript scripts.',
  },
  {
    key: 'automations',
    path: '/automations',
    label: 'Browser',
    group: 'automation',
    description: 'Build, record & capture Playwright browser flows.',
  },
  {
    key: 'pipelines',
    path: '/pipelines',
    label: 'Pipelines',
    group: 'automation',
    description: 'Multi-stage script pipelines.',
  },
  {
    // Folded into the Browser builder — capturing screens + steps now happens in
    // the same session (see ui/src/pages/BuilderPage.tsx). Kept as a merged key so
    // an existing config that enabled `capture` still surfaces the Browser page,
    // and `/capture` redirects in (App.tsx).
    key: 'capture',
    path: '/capture',
    label: 'Capture',
    group: 'automation',
    mergedInto: 'automations',
    description: 'Record browser interactions step-by-step.',
  },
  {
    key: 'excel',
    path: '/excel',
    label: 'Excel',
    group: 'automation',
    description: 'Build CSV/xlsx workbook automations; reuse them as pipeline excel stages.',
  },
  {
    key: 'excel-automations',
    path: '/excel-automations',
    label: 'Excel Automations',
    group: 'automation',
    mergedInto: 'excel',
  },
  // ── Results hub ───────────────────────────────────────────────────────────
  { key: 'runs', path: '/runs', label: 'Runs', group: 'results', description: 'Run history and saved archives.' },
  { key: 'files', path: '/files', label: 'Output Files', group: 'results', description: 'Browse run output files.' },
  {
    key: 'test-reports',
    path: '/test-reports',
    label: 'Test Reports',
    group: 'results',
    description: 'Functional & e2e run reports with pass/fail, failures, and debug artifacts.',
  },
  { key: 'archives', path: '/archives', label: 'Archives', group: 'results', mergedInto: 'runs' },
  // ── Security hub ──────────────────────────────────────────────────────────
  {
    key: 'vulnerabilities',
    path: '/vulnerabilities',
    label: 'Vulnerabilities',
    group: 'security',
    description: 'Import AppScan/ASoC scan PDFs, compare issues across apps, generate remediation plans.',
  },
  { key: 'plans', path: '/plans', label: 'Plans', group: 'security', description: 'AI-generated remediation plans.' },
  // ── Top-level ─────────────────────────────────────────────────────────────
  {
    key: 'ask',
    path: '/chat',
    label: 'Ask',
    group: 'top',
    color: '#8b5cf6',
    description: 'Ask questions about your repos (local RAG chat).',
  },
  {
    key: 'art',
    path: '/art',
    label: 'Art Canvas',
    group: 'top',
    color: '#ec4899',
    description: 'Generate local art assets (icons, game art, UI mockups, textures).',
  },
  { key: 'board', path: '/board', label: 'Board', group: 'top', color: '#f59e0b', description: 'Kanban task board.' },
  {
    key: 'links',
    path: '/links',
    label: 'Links',
    group: 'top',
    color: '#06b6d4',
    description: 'Save, search & import a catalogue of URLs.',
  },
  {
    key: 'shell-aliases',
    path: '/shell-aliases',
    label: 'Aliases',
    group: 'top',
    color: '#10b981',
    description: 'Manage shell aliases, apply them to your shell config, and sync with cursedalchemy.',
  },
  {
    key: 'vault',
    path: '/vault',
    label: 'Vault',
    group: 'top',
    color: '#a855f7',
    description: 'Encrypted, master-password-gated store for logins & secrets.',
  },
  {
    key: 'taskq',
    path: '/taskq',
    label: 'Orchestration',
    group: 'top',
    color: '#10b981',
    description: 'SQLite-backed task queue: board, builder, history, usage + drainer control.',
  },
  {
    key: 'orchestration-processing',
    path: '/orchestration-processing',
    label: 'Orchestration Processing',
    group: 'top',
    color: '#0ea5e9',
    description: 'Per-category timing analytics for agent task-runner work (SQLite-backed).',
    mergedInto: 'taskq',
  },
  {
    key: 'forge',
    path: '/forge',
    label: 'Task Forge',
    group: 'top',
    color: '#a855f7',
    description:
      'Draft rough tasks; local Ollama rewrites them into queue-ready specs you can publish to the orchestrator.',
    mergedInto: 'taskq',
  },
  {
    key: 'customPages',
    path: '/pages',
    label: 'Pages',
    group: 'top',
    color: '#8b5cf6',
    description: 'Build your own dashboards from drag-and-drop widgets.',
  },
  {
    key: 'tools',
    path: '/tools',
    label: 'Tools',
    group: 'top',
    color: '#ec4899',
    description: 'curl, regex, cron, YAML and JSON tools.',
  },
  // ── Docs hub ──────────────────────────────────────────────────────────────
  {
    key: 'docs',
    path: '/docs/rubato',
    label: 'Rubato Docs',
    group: 'docs',
    description: 'Project READMEs and generated cheatsheets.',
  },
  {
    key: 'system-files',
    path: '/docs/system',
    label: 'System Files',
    group: 'docs',
    description: 'Edit ~/.claude/CLAUDE.md, ~/.zshrc, and other dotfiles.',
  },
  {
    key: 'env-compare',
    path: '/docs/env',
    label: 'Env Files',
    group: 'docs',
    description: "Search, compare, and edit apps' .env files — find which configs have or lack a key.",
  },
  {
    key: 'config',
    path: '/config',
    label: 'Config',
    group: 'docs',
    description: 'Your rubato config.json (read-only).',
  },
];

/** One category hub: its own sidebar entry that opens a tile dashboard of pages. */
export interface NavHub {
  /** Stable hub key — matches the `group` of its member pages. */
  key: Exclude<NavGroup, 'top'>;
  /** Router path of the hub landing page. */
  path: string;
  /** Sidebar / header label. */
  label: string;
  /** Header blurb. */
  description: string;
  /** Default accent color (hex). Overridable in Settings. */
  color: string;
}

/** The category hubs, in sidebar order. */
export const NAV_HUBS: NavHub[] = [
  {
    key: 'data',
    path: '/data',
    label: 'Data',
    description: 'Queries, integrations, and API requests.',
    color: '#3b82f6',
  },
  {
    key: 'automation',
    path: '/automation',
    label: 'Automation',
    description: 'Commands, scripts, browser, and pipeline automation.',
    color: '#f97316',
  },
  {
    key: 'results',
    path: '/results',
    label: 'Results',
    description: 'Run history, archives, and output files.',
    color: '#14b8a6',
  },
  {
    key: 'security',
    path: '/security',
    label: 'Security',
    description: 'Vulnerability scans and remediation plans.',
    color: '#f43f5e',
  },
  {
    key: 'docs',
    path: '/docs',
    label: 'Docs',
    description: 'Project docs, editable system files, and your rubato config.',
    color: '#64748b',
  },
];

/** One row of the sidebar: either a standalone page link or a hub link. */
export type SidebarEntry = { kind: 'page'; key: string } | { kind: 'hub'; key: string };

/**
 * The sidebar, in display order — top-level pages interleaved with the hubs. This
 * is the single source of truth for nav order; Settings can hide/recolor these
 * entries (stored in localStorage, not here).
 */
export const SIDEBAR: SidebarEntry[] = [
  { kind: 'page', key: 'apps' },
  { kind: 'page', key: 'dashboard' },
  { kind: 'hub', key: 'data' },
  { kind: 'hub', key: 'automation' },
  { kind: 'hub', key: 'results' },
  { kind: 'hub', key: 'security' },
  { kind: 'page', key: 'ask' },
  { kind: 'page', key: 'board' },
  { kind: 'page', key: 'links' },
  { kind: 'page', key: 'shell-aliases' },
  { kind: 'page', key: 'vault' },
  { kind: 'page', key: 'taskq' },
  { kind: 'page', key: 'customPages' },
  { kind: 'page', key: 'tools' },
  { kind: 'hub', key: 'docs' },
];

/** Member pages of a hub, in registry order, excluding pages merged into another. */
export function pagesInGroup(group: Exclude<NavGroup, 'top'>): UiPage[] {
  return UI_PAGES.filter((p) => p.group === group && !p.mergedInto);
}

/** Look up a page by key. */
export function pageByKey(key: string): UiPage | undefined {
  return UI_PAGES.find((p) => p.key === key);
}

/**
 * All pages default to enabled. Users show/hide individual sidebar entries via the
 * sidebar's per-row kebab menu (stored in localStorage as nav prefs). Explicit
 * `ui.pages.<key>` in `~/.rubato/config.json` still overrides when set.
 */
export function defaultPageEnabled(_key: string): boolean {
  return true;
}

/** The `ui` block of the config (all optional; absent → defaults apply). */
export interface UiConfig {
  /** Per-page enablement, keyed by `UiPage.key`. Missing → `defaultPageEnabled`. */
  pages?: Record<string, boolean>;
  /** Enable the Admin page (page toggles + backups + DB viewer). Default false. */
  admin?: boolean;
  /**
   * Names of apps-template entries hidden on THIS machine (per-machine, so it
   * lives in config — never in the git-tracked `apps.template.json`). Hidden
   * entries drop out of the templates page and return via its "Show hidden" menu.
   */
  hiddenTemplates?: string[];
}

/** Resolve every page's effective on/off state from the (possibly absent) config. */
export function resolvePages(ui: UiConfig | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of UI_PAGES) out[p.key] = ui?.pages?.[p.key] ?? defaultPageEnabled(p.key);
  // A page merged into another (e.g. `services` → `requests`) is now a tab of its
  // parent. So an existing config that enabled only the child still surfaces the
  // parent — the child's toggle counts toward the parent's visibility.
  for (const p of UI_PAGES) {
    if (p.mergedInto && out[p.key]) out[p.mergedInto] = true;
  }
  return out;
}

/** The resolved UI state the server hands the client (`GET /api/ui`). */
export interface UiState {
  /** Effective per-page enablement. */
  pages: Record<string, boolean>;
  /** Whether the Admin page is enabled. */
  admin: boolean;
}

/** A patch the client sends to change toggles (`POST /api/ui`). */
export interface UiConfigPatch {
  pages?: Record<string, boolean>;
  admin?: boolean;
}

// ── Admin: backups + DB-viewer wire types ────────────────────────────────────

/** A SQLite backup file on disk. */
export interface BackupInfo {
  /** Bare file name (e.g. `rubato-2026-06-12T14-30-45-123Z.sqlite`). */
  fileName: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time (Unix ms). */
  modifiedAt: number;
  /** True for an auto safety snapshot taken before a restore (`pre-restore-*`). */
  safety?: boolean;
}

/** A table name + its row count. */
export interface TableInfo {
  name: string;
  rowCount: number;
}

/** Per-table stats for the live DB viewer. */
export interface TableStat extends TableInfo {
  /** Bytes the table occupies, when the `dbstat` virtual table is available. */
  sizeBytes: number | null;
}

/** Live-DB overview: per-table stats + the DB file size. */
export interface DbStats {
  tables: TableStat[];
  dbFileBytes: number;
}

/** One column's name + declared SQLite type. */
export interface ColumnInfo {
  name: string;
  type: string;
}

/** A whitelisted filter operator. Nullary ops ignore `value`. */
export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'notcontains'
  | 'startswith'
  | 'endswith'
  | 'isnull'
  | 'isnotnull';

/** One column filter applied to a query. */
export interface QueryFilter {
  column: string;
  op: FilterOp;
  value?: string;
}

/** Body of a table-query request. */
export interface QueryRequest {
  filters?: QueryFilter[];
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
}

/** Result of a table query (a page of rows + the total matching count). */
export interface QueryResult {
  table: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

/** Outcome of restoring selected tables from a backup over the live DB. */
export interface RestoreResult {
  fileName: string;
  /** The safety snapshot taken before the restore (file name). */
  safetyBackup: string;
  restored: { table: string; rowsCopied: number }[];
  skipped: { table: string; reason: string }[];
}
