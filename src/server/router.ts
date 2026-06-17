/**
 * The rubato server's request handler — a pure `Request → Response` function so
 * it's testable without binding a port.
 *
 * Read API: /api/apps, /api/commands, /api/config, /api/health, /api/runs,
 * /api/runs/history (every run), /api/commands/saved (user-saved commands),
 * /api/files (+ /api/files/content) — the script-output files under the output dir.
 * Action: POST /api/run { command, args } runs a registered command and records
 * it; POST /api/commands/saved/:id/run runs a saved command. In production it
 * serves the built UI from ui/dist (SPA fallback); in dev,
 * Vite serves the UI and proxies /api here. With no built UI it falls back to a
 * single-file explorer.
 */

import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isAppError } from 'cwip';
import { parseLoose } from 'cwip/json';
import { makeCorrelationId } from 'cwip/node';
import { COMMANDS, commandTags } from '../commands';
import {
  type AppConfig,
  findMatches,
  loadApps,
  readPackageJson,
  removeApp,
  setAppDb,
  setAppLinks,
  setAppTags,
} from '../lib/apps';
import { renderCommandsByExample } from '../lib/commandsDoc';
import { expandPath, loadConfig, OUTPUTS_DIR, type RubatoConfig, saveConfig, setUiConfig } from '../lib/config';
import { runWithCorrelation } from '../lib/correlation';
import { detectTechFromPackageJson } from '../lib/detectAppTech';
import { openInEditor } from '../lib/editor';
import { findPackageRoot } from '../lib/pkgPaths';
import type { PluginRouteHandler } from '../plugin/types';
import type { AskAttachment } from '../shared/types';
import { resolvePages, type UiConfig, type UiConfigPatch, type UiPage, type UiState } from '../shared/ui';
import { handleAdminApi } from './adminRoutes';
import { getStatus } from './aiDb';
import { indexApp } from './aiIndex';
import { getAppBranches, isBranchAction, runAppBranchAction } from './appBranches';
import { cloneAndRegister, fillGitUrls } from './appClone';
import { appDetails } from './appDetails';
import {
  asDiffBase,
  getAppDiff,
  getAppFileDiff,
  getAppFullDiff,
  isAppDiffAction,
  isAppGitAction,
  runAppDiffAction,
  runAppGitAction,
} from './appGit';
import { getAppCommitFileDiff, getAppCommitFiles, getAppCommitFullDiff, getAppLog } from './appLog';
import { getAppDeploy, getAppJenkins, getAppOpenshift, refreshAppCaches } from './appOverview';
import { openAppPr } from './appPr';
import {
  getAppStashes,
  getAppStashFileDiff,
  getAppStashFiles,
  getAppStashFullDiff,
  isStashAction,
  runAppStashAction,
  type StashDiffMode,
} from './appStash';
import {
  addAppsToTemplate,
  applyTemplateEntries,
  commitTemplate,
  createTemplateEntries,
  editTemplateEntry,
  getTemplateStatus,
  removeTemplateEntries,
  setHiddenTemplates,
  sortTemplate,
  templateDiff,
} from './appsTemplate';
import { createAppTag, getAppTags, isTagAction, runAppTagAction } from './appTags';
import { startAsk } from './ask';
import { handleAuthApi } from './authRoutes';
import { handleAutomationApi, handleSessionApi } from './automationRoutes';
import { handleBoardApi } from './boardRoutes';
import { handleCaptureApi } from './captureRoutes';
import { handleCommandsApi } from './commandRoutes';
import { handleCustomPagesApi } from './customPagesRoutes';
import { handleDashboardApi } from './dashboardRoutes';
import {
  archiveRun,
  deleteArchive,
  deleteConversation,
  getCommandStats,
  getConversation,
  getMessages,
  listArchives,
  listConversations,
  listRunHistory,
  listRuns,
} from './db';
import { handleDbQueryApi } from './dbQueryRoutes';
import { handleDebugCaptureApi } from './debugCaptureRoutes';
import { handleEnvDiscoveryApi } from './envDiscovery';
import { listAppEnvFiles, readAppEnvFile, writeAppEnvFile } from './envFiles';
import { handleExcelAutomationApi } from './excelAutomationRoutes';
import { listOutputFiles, readOutputFile, resolveOutputFile } from './files';
import { json, jsonError, readJsonBody } from './http';
import { handleLinksApi } from './linksRoutes';
import { handleShellAliasApi } from './shellAliasRoutes';
import { handleOrchestrationApi } from './orchestrationRoutes';
import { handleTaskqApi } from './taskqRoutes';
import { handlePipelineApi } from './pipelineRoutes';
import { handlePlansApi } from './plansRoutes';
import { handleRallyApi } from './rallyRoutes';
import { handleRequestApi } from './requestRoutes';
import { runCommand, startBackgroundRun } from './run';
import { handleScriptApi } from './scriptRoutes';
import { handleSearchApi } from './searchRoutes';
import { handleServiceNowApi } from './servicenowRoutes';
import { handleServiceApi } from './serviceRoutes';
import { handleSplunkApi } from './splunkRoutes';
import { listSystemFiles, readSystemFile, writeSystemFile } from './systemFiles';
import { readSystemHealthFile, runSystemHealth } from './systemHealth';
import { handleTestReportsApi } from './testReportsRoutes';
import { handleToolsApi } from './toolsRoutes';
import { UI_HTML } from './ui';
import { handleVaultApi } from './vaultRoutes';
import { handleVulnerabilitiesApi } from './vulnerabilitiesRoutes';

/** Resolve an app by exact registry name, falling back to fuzzy match keys. */
async function resolveAppByName(name: string): Promise<AppConfig | null> {
  const apps = await loadApps();
  return apps.find((a) => a.name === name) ?? findMatches(name, apps)[0] ?? null;
}

/** Defensive caps on ask attachments (the prompt builder also trims to a token budget). */
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_CHARS = 200_000;

/** Validate + bound attachments from a request body; returns undefined when none. */
function capAttachments(raw: unknown): AskAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AskAttachment[] = [];
  for (const a of raw.slice(0, MAX_ATTACHMENTS)) {
    if (a && typeof a.name === 'string' && typeof a.content === 'string') {
      out.push({ name: a.name.slice(0, 200), content: a.content.slice(0, MAX_ATTACHMENT_CHARS) });
    }
  }
  return out.length ? out : undefined;
}

const REPO_ROOT = findPackageRoot(import.meta.dir);
const UI_DIST = resolve(REPO_ROOT, 'ui/dist');

/**
 * Per-request wiring injected by {@link startServer} (assembled by `startApp`
 * from the chosen plugins). All optional — with none, `route()` behaves exactly
 * like rubato's own monolithic server (built-in routes only, rubato's `ui/dist`).
 */
export interface RouteOptions {
  /** Plugin-owned routes, tried before the built-in chain (first prefix wins). */
  pluginRoutes?: PluginRouteHandler[];
  /** Plugin page declarations, merged into `GET /api/ui` so the nav can list them. */
  pluginPages?: UiPage[];
  /** Absolute path to the SPA to serve; defaults to rubato's own `ui/dist`. */
  uiDist?: string;
  /** Runtime branding for the served SPA — re-theme/re-title the *prebuilt* UI
   *  without rebuilding it (a friend app passing its own accent + tab title). */
  ui?: UiBranding;
}

/**
 * Runtime branding injected into the served `index.html`. Lets a friend app fully
 * white-label rubato's prebuilt SPA — no rebuild — by overriding the accent design
 * token (the whole brand surface derives from it), the browser tab title, AND the
 * in-app wordmark (sidebar/header), which the chrome reads from an injected meta tag.
 */
export interface UiBranding {
  /** Brand accent as a CSS color (hex/rgb/hsl/named); derives hover + soft + dark. */
  accent?: string;
  /** Explicit hover shade (default: a darkened `accent` via color-mix). */
  accentHover?: string;
  /** Explicit soft-background shade (default: a translucent `accent`). */
  accentSoft?: string;
  /** Brand name — sets the browser tab `<title>` AND the in-app wordmark (the
   *  sidebar/header text), so the UI says your app's name instead of "rubato". */
  brand?: string;
}

/**
 * Repo docs viewable in the UI, resolved fresh per request (never copied) from
 * three sources, in order:
 *   1. the canonical root files below (the overview/cheatsheet docs);
 *   2. generated docs (e.g. the command cheatsheet) rendered live from the
 *      registry, so they can't drift;
 *   3. any `*.md` dropped into `docs/`, which appear automatically.
 * The resolved name→source set is itself the path-traversal guard: a requested
 * name must match an entry exactly (root/generated literals, readdir basenames —
 * none carry a `/`), so `../…` can never resolve. Don't swap it for a glob.
 */
const ROOT_DOCS = ['OVERVIEW.md', 'COMMANDS.md', 'ROADMAP.md', 'SANDBOX.md'];
const DOCS_DIR = resolve(REPO_ROOT, 'docs');

/** Generated (virtual) docs: a name → live markdown renderer, no file on disk. */
const GENERATED_DOCS: Record<string, () => string> = {
  'commands-by-example.md': renderCommandsByExample,
};

type DocSource = { name: string } & ({ path: string } | { render: () => string });

/** Ordered, deduped viewable docs (root → generated → docs/ alphabetically). */
async function listDocs(): Promise<DocSource[]> {
  const out: DocSource[] = [];
  const seen = new Set<string>();
  const add = (doc: DocSource) => {
    if (!seen.has(doc.name)) {
      out.push(doc);
      seen.add(doc.name);
    }
  };

  for (const name of ROOT_DOCS) {
    if (await Bun.file(resolve(REPO_ROOT, name)).exists()) add({ name, path: resolve(REPO_ROOT, name) });
  }
  for (const [name, render] of Object.entries(GENERATED_DOCS)) add({ name, render });
  try {
    for (const name of (await readdir(DOCS_DIR)).filter((f) => f.endsWith('.md')).sort()) {
      add({ name, path: resolve(DOCS_DIR, name) });
    }
  } catch {
    // no docs/ dir yet — root + generated only
  }
  return out;
}

/** Serve a file from the built UI (`distDir`, default rubato's own `ui/dist`),
 *  or null if it doesn't exist. A friend app passes its own built SPA dir. */
async function serveStatic(pathname: string, distDir: string = UI_DIST): Promise<Response | null> {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = Bun.file(resolve(distDir, `.${rel}`));
  return (await file.exists()) ? new Response(file) : null;
}

/** Keep an injected CSS color value from breaking out of the `<style>` block. */
function safeColor(c: string): string {
  return /^[#a-zA-Z0-9(),.%\s-]+$/.test(c) ? c : '';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** True if branding actually changes anything (so an empty `ui` is a no-op). */
function hasBranding(ui?: UiBranding): ui is UiBranding {
  return !!ui && (!!ui.accent || !!ui.brand);
}

/**
 * Inject runtime branding into the prebuilt `index.html`: a `<style>` overriding the
 * `--accent` design tokens (the whole brand surface derives from them; hover/soft/
 * dark shades come from the one accent via `color-mix`) and, optionally, the tab
 * `<title>`. A no-op string transform — the prebuilt assets are untouched.
 */
export function injectBranding(html: string, ui: UiBranding): string {
  let out = html;
  const accent = ui.accent ? safeColor(ui.accent) : '';
  if (accent) {
    const hover = (ui.accentHover && safeColor(ui.accentHover)) || `color-mix(in srgb, ${accent} 85%, black)`;
    const soft = (ui.accentSoft && safeColor(ui.accentSoft)) || `color-mix(in srgb, ${accent} 14%, transparent)`;
    const dark = `color-mix(in srgb, ${accent} 72%, white)`;
    const style =
      `<style data-rubato-theme>` +
      `:root{--accent:${accent};--accent-hover:${hover};--accent-soft:${soft};}` +
      `.dark{--accent:${dark};--accent-hover:${accent};--accent-soft:color-mix(in srgb, ${accent} 28%, black);}` +
      `</style>`;
    // Inject at the END of <head> so it wins over the linked theme CSS (equal
    // specificity → later rule applies).
    out = out.includes('</head>') ? out.replace('</head>', `${style}</head>`) : `${style}${out}`;
  }
  if (ui.brand) {
    const brand = escapeHtml(ui.brand);
    // The tab title…
    const title = `<title>${brand}</title>`;
    out = /<title>[\s\S]*?<\/title>/i.test(out) ? out.replace(/<title>[\s\S]*?<\/title>/i, title) : out;
    // …and the in-app wordmark: a <meta> the prebuilt chrome reads (see ui appBrand),
    // so the sidebar/header say the friend app's name, not "rubato" — no SPA rebuild.
    const meta = `<meta name="app-brand" content="${brand}">`;
    out = out.includes('</head>') ? out.replace('</head>', `${meta}</head>`) : `${meta}${out}`;
  }
  return out;
}

/** Serve the SPA's `index.html`, applying runtime branding when configured. */
async function serveIndex(distDir: string = UI_DIST, ui?: UiBranding): Promise<Response | null> {
  const file = Bun.file(resolve(distDir, 'index.html'));
  if (!(await file.exists())) return null;
  if (!hasBranding(ui)) return new Response(file);
  return new Response(injectBranding(await file.text(), ui), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/** Hard ceiling on a request body, so a runaway/huge POST can't OOM the loopback server. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** Content types for inline-served output files (GET /api/files/raw). */
const INLINE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

async function handleApi(pathname: string, req: Request, opts: RouteOptions = {}): Promise<Response> {
  // Reject oversized bodies up front (Content-Length is advisory but catches the common case).
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return jsonError(`request body too large (max ${MAX_BODY_BYTES} bytes)`, 413);
  }

  // Plugin-owned routes first: the first handler whose prefix matches wins, then
  // we fall through to rubato's built-in chain below. Rubato's own boot passes no
  // plugin routes, so this loop is a no-op for the monolith.
  for (const handler of opts.pluginRoutes ?? []) {
    const prefixes = Array.isArray(handler.prefix) ? handler.prefix : [handler.prefix];
    if (prefixes.some((p) => pathname.startsWith(p))) return handler.handle(pathname, req);
  }

  // Admin API (backups + DB viewer), gated by `ui.admin` inside the handler.
  if (pathname.startsWith('/api/admin/')) return handleAdminApi(pathname, req);

  // Universal content search across the user-authored items.
  if (pathname === '/api/search') return handleSearchApi(pathname, req);

  // Cross-app .env discovery/search (which apps have/lack a key, by group/all).
  if (pathname === '/api/env-discovery') return handleEnvDiscoveryApi(pathname, req);

  // Test Reports console (functional/e2e run reports + debug artifacts).
  if (pathname === '/api/test-reports' || pathname.startsWith('/api/test-reports/')) {
    return handleTestReportsApi(pathname, req);
  }

  // Web-UI page enablement: GET resolves toggles for the nav; POST persists changes.
  // The nav is scoped to the host's feature set:
  //   • rubato's own boot passes no pluginPages → the FULL built-in page set
  //     (resolvePages over UI_PAGES, each default-enabled).
  //   • A friend app passes pluginPages → ONLY those pages (an empty base), so its
  //     nav shows exactly the plugins it assembled, not all of rubato's pages.
  // A plugin's pages are enabled by default (you included the plugin, so you want
  // its page) but an explicit `ui.pages.<key>` config toggle still wins.
  if (pathname === '/api/ui') {
    const friendMode = (opts.pluginPages ?? []).length > 0;
    const basePages = (ui: UiConfig | undefined): Record<string, boolean> => (friendMode ? {} : resolvePages(ui));
    const withPluginPages = (pages: Record<string, boolean>, ui: UiConfig | undefined): Record<string, boolean> => {
      for (const p of opts.pluginPages ?? []) pages[p.key] = ui?.pages?.[p.key] ?? true;
      return pages;
    };
    const cfg = await loadConfig();
    if (req.method === 'POST') {
      let patch: UiConfigPatch;
      try {
        patch = (await req.json()) as UiConfigPatch;
      } catch {
        return jsonError('invalid JSON body', 400);
      }
      const ui = await setUiConfig(patch);
      return json({ pages: withPluginPages(basePages(ui), ui), admin: ui.admin === true } satisfies UiState);
    }
    return json({
      pages: withPluginPages(basePages(cfg.ui), cfg.ui),
      admin: cfg.ui?.admin === true,
    } satisfies UiState);
  }

  // Playwright automation builder routes (parameterized; handled before the switch).
  if (pathname.startsWith('/api/automation-runs') || pathname.startsWith('/api/automations')) {
    return handleAutomationApi(pathname, req);
  }
  if (pathname.startsWith('/api/session/')) return handleSessionApi(pathname, req);

  // Capture / data-gathering recorder (record screens+actions → exportable bundle).
  if (pathname === '/api/capture' || pathname.startsWith('/api/capture/')) {
    return handleCaptureApi(pathname, req);
  }

  // Debug capture (outbound API + DB request/response → sealed exportable string).
  if (pathname === '/api/debug-capture' || pathname.startsWith('/api/debug-capture/')) {
    return handleDebugCaptureApi(pathname, req);
  }

  // Session/JWT fetching against the environment's IdP.
  if (pathname.startsWith('/api/auth/')) return handleAuthApi(pathname, req);

  // Custom scripts (registered in-process or discovered ~/.rubato/scripts).
  if (pathname === '/api/scripts' || pathname.startsWith('/api/scripts/')) return handleScriptApi(pathname, req);

  // Pipelines (chain heterogeneous stages, sharing a vars bag + run dir).
  if (pathname === '/api/pipeline-runs' || pathname.startsWith('/api/pipelines')) {
    return handlePipelineApi(pathname, req);
  }

  // Excel Automations: upload a workbook → declarative step engine → revision chain.
  if (
    pathname === '/api/excel-automations' ||
    pathname.startsWith('/api/excel-automations/') ||
    pathname === '/api/excel-recipes' ||
    pathname.startsWith('/api/excel-recipes/')
  ) {
    return handleExcelAutomationApi(pathname, req);
  }

  // Service catalog runner (Datadog/Dynatrace/GitHub/GitLab/Quay/Rancher/Harness).
  if (pathname === '/api/services' || pathname.startsWith('/api/services/')) return handleServiceApi(pathname, req);

  // Saved Tools-tab items (curl requests + regexes).
  if (pathname.startsWith('/api/tools/')) return handleToolsApi(pathname, req);

  // Request builder (run + saved requests + environments).
  if (
    pathname === '/api/requests' ||
    pathname.startsWith('/api/requests/') ||
    pathname === '/api/environments' ||
    pathname.startsWith('/api/environments/')
  ) {
    return handleRequestApi(pathname, req);
  }

  // Board (kanban work tasks + image attachments).
  if (pathname === '/api/board' || pathname.startsWith('/api/board/')) return handleBoardApi(pathname, req);

  // Links (bookmark / link manager + bookmarks-HTML import).
  if (pathname === '/api/links' || pathname.startsWith('/api/links/')) return handleLinksApi(pathname, req);

  // Shell aliases (user-defined name→command pairs, system shell config setup, ca export/import).
  if (pathname === '/api/shell-aliases' || pathname.startsWith('/api/shell-aliases/')) return handleShellAliasApi(pathname, req);

  // Vault (encrypted, master-password-gated credential store).
  if (pathname === '/api/vault' || pathname.startsWith('/api/vault/')) return handleVaultApi(pathname, req);

  // Custom Pages (user-built dashboards on the shared layout engine).
  if (pathname === '/api/pages' || pathname.startsWith('/api/pages/')) {
    return handleCustomPagesApi(pathname, req);
  }

  // Vulnerabilities (per-app AppScan/ASoC scan stats).
  if (pathname === '/api/vulnerabilities' || pathname.startsWith('/api/vulnerabilities/')) {
    return handleVulnerabilitiesApi(pathname, req);
  }

  // AI remediation plans (Markdown docs; view/edit/export).
  if (pathname === '/api/plans' || pathname.startsWith('/api/plans/')) {
    return handlePlansApi(pathname, req);
  }

  // Orchestration (unattended task-queue workflow dashboard: TASKS.md board,
  // Tasks_Completed.md history, runs/*.jsonl, + allowlisted config/doc editor).
  if (pathname === '/api/orchestration' || pathname.startsWith('/api/orchestration/')) {
    return handleOrchestrationApi(pathname, req);
  }

  // Taskq (v2 orchestrator): SQLite-backed task board CRUD (cwip/taskq engine).
  if (pathname === '/api/taskq' || pathname.startsWith('/api/taskq/')) {
    return handleTaskqApi(pathname, req);
  }

  // Dashboard (per-app status aggregation + tagging).
  if (pathname === '/api/dashboard' || pathname.startsWith('/api/dashboard/')) {
    return handleDashboardApi(pathname, req);
  }

  // Query builder (DB connections + saved queries + gated execution).
  if (
    pathname === '/api/db-connections' ||
    pathname.startsWith('/api/db-connections/') ||
    pathname === '/api/db-queries' ||
    pathname.startsWith('/api/db-queries/')
  ) {
    return handleDbQueryApi(pathname, req);
  }

  // ServiceNow (connections + saved requests + gated execution).
  if (
    pathname === '/api/servicenow-connections' ||
    pathname.startsWith('/api/servicenow-connections/') ||
    pathname === '/api/servicenow-requests' ||
    pathname.startsWith('/api/servicenow-requests/')
  ) {
    return handleServiceNowApi(pathname, req);
  }

  // Rally (story/task lookup + task update) — credential-gated (412 without creds).
  if (pathname.startsWith('/api/rally/')) return handleRallyApi(pathname, req);

  // Splunk query builder (parameterized; handled before the switch).
  if (pathname.startsWith('/api/splunk/')) return handleSplunkApi(pathname, req);

  // Saved commands (parameterized). Exact "/api/commands" is the registry list,
  // handled in the switch — only "/api/commands/saved*" is owned here.
  if (pathname === '/api/commands/saved' || pathname.startsWith('/api/commands/saved/')) {
    return handleCommandsApi(pathname, req);
  }

  // GET /api/commands/:name/source — the on-disk script backing a built-in
  // command, for its detail page. The path comes ONLY from the trusted registry
  // (resolve against the command's own `script`), so there's no traversal risk.
  if (pathname.startsWith('/api/commands/') && pathname.endsWith('/source')) {
    const name = decodeURIComponent(pathname.slice('/api/commands/'.length, -'/source'.length));
    const cmd = COMMANDS.find((c) => c.name === name);
    if (!cmd) return jsonError(`unknown command: ${name}`, 404);
    try {
      const source = await Bun.file(resolve(REPO_ROOT, cmd.script)).text();
      return json({ name: cmd.name, script: cmd.script, source });
    } catch {
      return jsonError(`could not read script: ${cmd.script}`, 404);
    }
  }

  // GET /api/runs/history(?command=) → the append-only run history (every run).
  if (pathname === '/api/runs/history') {
    const command = new URL(req.url).searchParams.get('command') ?? undefined;
    return json(listRunHistory(command));
  }

  // POST /api/open { path } — open ANY file/dir in the configured editor (the
  // `gotab`/`openInEditor` mechanism, but for an arbitrary path rather than a
  // registered app). This is what the UI's "open in editor" buttons hit wherever
  // a filesystem path is shown (config.json, .env, a run's outputPath, a
  // command's script, …). Loopback single-user server, so opening
  // an arbitrary local path — including secrets the user wants to edit — is the
  // point; there is no denylist here. `~`/absolute paths expand directly;
  // relative paths resolve against the output dir (the only relative paths the UI
  // shows — the Files tab + diagnostics — are output-dir-scoped).
  if (pathname === '/api/open') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    let body: { path?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('invalid JSON body', 400);
    }
    const raw = typeof body.path === 'string' ? body.path.trim() : '';
    if (!raw) return jsonError('path required', 400);
    const abs = raw.startsWith('~') || isAbsolute(raw) ? expandPath(raw) : resolve(OUTPUTS_DIR, raw);
    try {
      return json(await openInEditor(abs));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'open failed', 500);
    }
  }

  // GET  /api/servers/ssh → list configured SSH servers + their commands (localhost only).
  // POST /api/servers/ssh/open { index? } → open an SSH session in a native terminal.
  if (pathname === '/api/servers/ssh') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    const { buildSshCommand, serverLabel } = await import('./sshServers');
    const cfg = await loadConfig();
    const servers = cfg.servers?.ssh ?? [];
    return json(servers.map((s, i) => ({ index: i, label: serverLabel(s), command: buildSshCommand(s) })));
  }
  if (pathname === '/api/servers/ssh/open') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const { openSshInTerminal } = await import('./sshServers');
    let body: { index?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* no body */
    }
    const idx = typeof body.index === 'number' ? body.index : 0;
    const cfg = await loadConfig();
    const servers = cfg.servers?.ssh ?? [];
    if (servers.length === 0) return jsonError('No SSH servers configured in servers.ssh', 404);
    const server = servers[idx];
    if (!server) return jsonError(`No server at index ${idx}`, 404);
    try {
      const result = await openSshInTerminal(server);
      return json(result);
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'failed to open terminal', 500);
    }
  }

  // GET /api/files → list script-output files; GET /api/files/content?path= → one file's text.
  if (pathname === '/api/files') {
    return json(await listOutputFiles());
  }
  if (pathname === '/api/files/content') {
    const path = new URL(req.url).searchParams.get('path') ?? '';
    if (!path) return jsonError('path required', 400);
    const result = await readOutputFile(path);
    if (!result.ok) return jsonError(result.error, result.status);
    return json({ file: result.file, content: result.content });
  }
  // GET /api/files/download?path= → stream a file as an attachment (any size).
  if (pathname === '/api/files/download') {
    const path = new URL(req.url).searchParams.get('path') ?? '';
    if (!path) return jsonError('path required', 400);
    const resolved = await resolveOutputFile(path);
    if (!resolved.ok) return jsonError(resolved.error, resolved.status);
    return new Response(Bun.file(resolved.realAbs), {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${resolved.file.name}"`,
      },
    });
  }
  // GET /api/files/raw?path= → serve a file INLINE (image/html) with a guessed
  // content-type, so the run-history UI can <img>/iframe captured snapshots.
  // Captured HTML is served sandboxed (CSP `sandbox`) so its inline scripts can't
  // run in the rubato origin — it's a debugging artifact, not a trusted page.
  if (pathname === '/api/files/raw') {
    const path = new URL(req.url).searchParams.get('path') ?? '';
    if (!path) return jsonError('path required', 400);
    const resolved = await resolveOutputFile(path);
    if (!resolved.ok) return jsonError(resolved.error, resolved.status);
    const ext = resolved.file.name.split('.').pop()?.toLowerCase() ?? '';
    const headers: Record<string, string> = {
      'content-type': INLINE_TYPES[ext] ?? 'text/plain; charset=utf-8',
      'content-disposition': `inline; filename="${resolved.file.name}"`,
      'x-content-type-options': 'nosniff',
    };
    if (ext === 'html' || ext === 'htm') headers['content-security-policy'] = 'sandbox';
    return new Response(Bun.file(resolved.realAbs), { headers });
  }

  // GET /api/docs → list; GET /api/docs/:name → raw markdown (root + generated + docs/).
  if (pathname === '/api/docs' || pathname.startsWith('/api/docs/')) {
    const docs = await listDocs();
    const name = pathname === '/api/docs' ? '' : decodeURIComponent(pathname.slice('/api/docs/'.length));
    if (!name) return json(docs.map((d) => d.name));
    const doc = docs.find((d) => d.name === name);
    if (!doc) return jsonError(`unknown doc: ${name}`, 404);
    const headers = { 'content-type': 'text/markdown; charset=utf-8' };
    return 'render' in doc ? new Response(doc.render(), { headers }) : new Response(Bun.file(doc.path), { headers });
  }

  // GET /api/system-files → list the editable allowlisted files (no content).
  if (pathname === '/api/system-files') {
    return json(await listSystemFiles());
  }
  // GET /api/system-files/:key → one file (view); POST writes it. The key maps to a
  // fixed server-derived path (see systemFiles.ts) — the client never sends a path.
  if (pathname.startsWith('/api/system-files/')) {
    const key = decodeURIComponent(pathname.slice('/api/system-files/'.length));
    if (!key) return jsonError('file key required', 400);
    if (req.method === 'POST') {
      const body = await readJsonBody<{ content?: string }>(req);
      if (!body || typeof body.content !== 'string') return jsonError('content (string) required', 400);
      try {
        const doc = await writeSystemFile(key, body.content);
        return doc ? json(doc) : jsonError(`unknown system file: ${key}`, 404);
      } catch (e) {
        return jsonError(e instanceof Error ? e.message : 'write failed', 400);
      }
    }
    const doc = await readSystemFile(key);
    return doc ? json(doc) : jsonError(`unknown system file: ${key}`, 404);
  }

  // DELETE /api/archives/:id — parameterized, so handled before the exact switch.
  if (pathname.startsWith('/api/archives/')) {
    if (req.method !== 'DELETE') return jsonError('use DELETE', 405);
    const id = Number(pathname.slice('/api/archives/'.length));
    if (!Number.isInteger(id)) return jsonError('invalid archive id', 400);
    return json({ deleted: deleteArchive(id) });
  }

  // GET/DELETE /api/conversations/:id — parameterized.
  if (pathname.startsWith('/api/conversations/')) {
    const id = decodeURIComponent(pathname.slice('/api/conversations/'.length));
    if (!id) return jsonError('conversation id required', 400);
    if (req.method === 'DELETE') return json({ deleted: deleteConversation(id) });
    const conversation = getConversation(id);
    if (!conversation) return jsonError(`no conversation: ${id}`, 404);
    return json({ conversation, messages: getMessages(id) });
  }

  // POST /api/index/:app (reindex) and GET /api/index/:app/status — parameterized.
  if (pathname.startsWith('/api/index/')) {
    const rest = pathname.slice('/api/index/'.length);
    const isStatus = rest.endsWith('/status');
    const appName = decodeURIComponent(isStatus ? rest.slice(0, -'/status'.length) : rest);
    if (!appName) return jsonError('app required', 400);
    if (isStatus) return json(getStatus(appName) ?? { app: appName, state: 'missing' });
    if (req.method !== 'POST') return jsonError('use POST', 405);
    const app = await resolveAppByName(appName);
    if (!app) return jsonError(`unknown app: ${appName}`, 404);
    return json(await indexApp(app));
  }

  // POST /api/apps/clone { url, dest, name?, group? } — clone a repo + register it.
  if (pathname === '/api/apps/clone') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError('invalid JSON body', 400);
    }
    const r = await cloneAndRegister(body);
    return r.ok ? json(r.app) : jsonError(r.error, 400);
  }
  // POST /api/apps/fill-git-urls — backfill cloneUrl from each repo's origin.
  if (pathname === '/api/apps/fill-git-urls') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    return json(await fillGitUrls());
  }

  // Apps template (the shared, repo-tracked apps.template.json of <HOME>-relative
  // entries you fill once and apply per-machine). Registered BEFORE the generic
  // /api/apps/:name handler below so "template" isn't parsed as an app name.
  //   GET  /api/apps/template          → every entry annotated with applied/exists status
  //   POST /api/apps/template/apply    { names } → add chosen entries to the local registry
  //   POST /api/apps/template/add      { names } → save chosen registry apps into the template
  //   POST /api/apps/template/remove   { names } → drop entries from the template
  //   GET  /api/apps/template/diff     → unified diff of the template vs its last commit
  //   POST /api/apps/template/commit   { message? } → git-commit just the template file
  //   POST /api/apps/template/create   { entries } → add new hand-authored entries (JS/JSON)
  //   POST /api/apps/template/edit     { originalName, entry } → replace one entry (rename ok)
  //   POST /api/apps/template/sort     → sort entries alphabetically by name
  //   POST /api/apps/template/hidden   { names } → set the per-machine hidden set
  if (pathname === '/api/apps/template') {
    return json(await getTemplateStatus());
  }
  if (pathname === '/api/apps/template/diff') {
    return json(await templateDiff());
  }
  if (pathname === '/api/apps/template/commit') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    let body: { message?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {}; // message is optional → an empty/absent body is fine
    }
    const message = typeof body.message === 'string' ? body.message : undefined;
    return json(await commitTemplate(message));
  }
  if (pathname === '/api/apps/template/sort') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    return json(await sortTemplate());
  }
  if (pathname === '/api/apps/template/create' || pathname === '/api/apps/template/edit') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    let body: { entries?: unknown; entry?: unknown; originalName?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('invalid JSON body', 400);
    }
    if (pathname.endsWith('/create')) {
      const entries = body.entries ?? body.entry;
      if (entries === undefined) return jsonError('entries required', 400);
      return json(await createTemplateEntries(entries));
    }
    if (typeof body.originalName !== 'string') return jsonError('originalName required', 400);
    if (!body.entry || typeof body.entry !== 'object') return jsonError('entry (object) required', 400);
    return json(await editTemplateEntry(body.originalName, body.entry));
  }
  if (pathname === '/api/apps/template/hidden') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    let body: { names?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('invalid JSON body', 400);
    }
    // An empty list is valid here — it means "restore all" (clear the hidden set).
    const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === 'string') : [];
    return json(await setHiddenTemplates(names));
  }
  if (
    pathname === '/api/apps/template/apply' ||
    pathname === '/api/apps/template/add' ||
    pathname === '/api/apps/template/remove'
  ) {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    let body: { names?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('invalid JSON body', 400);
    }
    const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === 'string') : [];
    if (!names.length) return jsonError('names[] required', 400);
    if (pathname.endsWith('/apply')) return json(await applyTemplateEntries(names));
    if (pathname.endsWith('/add')) return json(await addAppsToTemplate(names));
    return json(await removeTemplateEntries(names));
  }

  // GET /api/apps/:name/details — live README + git status for one app;
  // POST /api/apps/:name/open — open the app's dir in the configured editor.
  if (pathname.startsWith('/api/apps/')) {
    const rest = pathname.slice('/api/apps/'.length);
    const slash = rest.lastIndexOf('/');
    const action = slash >= 0 ? rest.slice(slash + 1) : '';
    const appName = decodeURIComponent(slash >= 0 ? rest.slice(0, slash) : rest);
    // DELETE /api/apps/:name — unregister an app (drop its entry from apps.json).
    // Files on disk are untouched; this only removes the registry record.
    if (action === '' && req.method === 'DELETE') {
      const removed = await removeApp(appName);
      if (!removed) return jsonError(`unknown app: ${appName}`, 404);
      return json({ deleted: true, name: removed.name });
    }
    const APP_ACTIONS = [
      'details',
      'open',
      'links',
      'db',
      'tech-tags',
      'detect-tech',
      'env-files',
      'git',
      'diff',
      'stash',
      'tags',
      'jenkins',
      'deploy',
      'openshift',
      'refresh',
      'log',
      'branches',
      'pr',
    ];
    if (!appName || !APP_ACTIONS.includes(action)) {
      return jsonError(`not found: ${pathname}`, 404);
    }
    const app = await resolveAppByName(appName);
    if (!app) return jsonError(`unknown app: ${appName}`, 404);
    if (action === 'open') {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      try {
        return json(await openInEditor(app.absolutePath));
      } catch (e) {
        return jsonError(e instanceof Error ? e.message : 'open failed', 500);
      }
    }
    // POST /api/apps/:name/links — set this app's shortcut links. Body: { links }.
    if (action === 'links') {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      let body: { links?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('invalid JSON body', 400);
      }
      const updated = await setAppLinks(app.name, body.links);
      if (!updated) return jsonError(`unknown app: ${app.name}`, 404);
      return json(updated);
    }
    // POST /api/apps/:name/db — set this app's database list. Body: { db: string[] }.
    if (action === 'db') {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      let body: { db?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('invalid JSON body', 400);
      }
      const updated = await setAppDb(app.name, body.db);
      if (!updated) return jsonError(`unknown app: ${app.name}`, 404);
      return json(updated);
    }
    // POST /api/apps/:name/tech-tags — set this app's free-form tech tags. Body: { tags: string[] }.
    // (Distinct from /tags, which manages git tags.)
    if (action === 'tech-tags') {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      let body: { tags?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('invalid JSON body', 400);
      }
      const updated = await setAppTags(app.name, body.tags);
      if (!updated) return jsonError(`unknown app: ${app.name}`, 404);
      return json(updated);
    }
    // GET /api/apps/:name/detect-tech — suggest db tags from the app's package.json
    // drivers (read live, never written). The UI offers them as one-click adds.
    if (action === 'detect-tech') {
      const pkg = await readPackageJson(app.absolutePath);
      return json(detectTechFromPackageJson(pkg));
    }
    // GET  /api/apps/:name/env-files            → list the app's .env* files
    // GET  /api/apps/:name/env-files?path=<rel> → one file's { info, content }
    // POST /api/apps/:name/env-files { path, content } → write one file
    if (action === 'env-files') {
      if (req.method === 'GET') {
        const path = new URL(req.url).searchParams.get('path');
        if (!path) return json(await listAppEnvFiles(app.absolutePath));
        const read = await readAppEnvFile(app.absolutePath, path);
        return read.ok ? json(read) : jsonError(read.error, read.status);
      }
      if (req.method === 'POST') {
        let body: { path?: unknown; content?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonError('invalid JSON body', 400);
        }
        if (typeof body.path !== 'string') return jsonError('path required', 400);
        const wrote = await writeAppEnvFile(app.absolutePath, body.path, String(body.content ?? ''));
        return wrote.ok ? json(wrote) : jsonError(wrote.error, wrote.status);
      }
      return jsonError('use GET or POST', 405);
    }
    // POST /api/apps/:name/git — run a git quick-action. Body: { action, message? }.
    if (action === 'git') {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      let body: { action?: unknown; message?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('invalid JSON body', 400);
      }
      if (!isAppGitAction(body.action)) {
        return jsonError('action must be one of pull|fetch|checkoutDefault|commitAll', 400);
      }
      const message = typeof body.message === 'string' ? body.message : undefined;
      return json(await runAppGitAction(app, body.action, message));
    }
    // GET /api/apps/:name/diff[?base=head|main|origin-main][?path=&untracked=1][?full=1]
    //   — base defaults to head (uncommitted). `path` → one file's diff; `full=1` →
    //   one combined diff of everything; otherwise the changed-file list.
    // POST /api/apps/:name/diff { action, paths? } — stash/discardAll/discard.
    if (action === 'diff') {
      if (req.method === 'GET') {
        const params = new URL(req.url).searchParams;
        const base = asDiffBase(params.get('base'));
        const path = params.get('path');
        if (path) return json(await getAppFileDiff(app, path, params.get('untracked') === '1', base));
        if (params.get('full') === '1') return json(await getAppFullDiff(app, base));
        return json(await getAppDiff(app, base));
      }
      if (req.method === 'POST') {
        let body: { action?: unknown; paths?: unknown; message?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonError('invalid JSON body', 400);
        }
        if (!isAppDiffAction(body.action)) {
          return jsonError('action must be one of stash|discardAll|discard|commit', 400);
        }
        const paths = Array.isArray(body.paths)
          ? body.paths.filter((p): p is string => typeof p === 'string')
          : undefined;
        const message = typeof body.message === 'string' ? body.message : undefined;
        return json(await runAppDiffAction(app, body.action, paths, message));
      }
      return jsonError('use GET or POST', 405);
    }
    // GET /api/apps/:name/stash — list stashes; ?ref=&mode=stash|worktree → that
    //   stash's files; +path=… → one file's diff; +full=1 → one combined diff.
    // POST /api/apps/:name/stash { action: drop|clear|apply|pop|undo, ref?, undoToken? }.
    if (action === 'stash') {
      if (req.method === 'GET') {
        const params = new URL(req.url).searchParams;
        const ref = params.get('ref');
        const mode: StashDiffMode = params.get('mode') === 'worktree' ? 'worktree' : 'stash';
        if (!ref) return json(await getAppStashes(app));
        const path = params.get('path');
        if (path) return json(await getAppStashFileDiff(app, ref, path, mode));
        if (params.get('full') === '1') return json(await getAppStashFullDiff(app, ref, mode));
        return json(await getAppStashFiles(app, ref, mode));
      }
      if (req.method === 'POST') {
        let body: { action?: unknown; ref?: unknown; undoToken?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonError('invalid JSON body', 400);
        }
        if (!isStashAction(body.action)) {
          return jsonError('action must be one of drop|clear|apply|pop|undo', 400);
        }
        const ref = typeof body.ref === 'string' ? body.ref : undefined;
        const undoToken = typeof body.undoToken === 'string' ? body.undoToken : null;
        return json(await runAppStashAction(app, { action: body.action, ref, undoToken }));
      }
      return jsonError('use GET or POST', 405);
    }
    // GET /api/apps/:name/tags — list tags + metadata.
    // POST /api/apps/:name/tags { action: create, name, ref?, message?, force? }
    //   | { action: checkout|delete, name }.
    if (action === 'tags') {
      if (req.method === 'GET') return json(await getAppTags(app));
      if (req.method === 'POST') {
        let body: { action?: unknown; name?: unknown; ref?: unknown; message?: unknown; force?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonError('invalid JSON body', 400);
        }
        if (body.action === 'create') {
          return json(
            await createAppTag(app, { name: body.name, ref: body.ref, message: body.message, force: !!body.force }),
          );
        }
        if (isTagAction(body.action)) return json(await runAppTagAction(app, body.action, body.name));
        return jsonError('action must be one of create|checkout|delete', 400);
      }
      return jsonError('use GET or POST', 405);
    }
    // Cross-domain per-app data (gated by the app's declared apis; soft-fail).
    //   GET /api/apps/:name/jenkins?env=&limit=   → recent Jenkins builds
    //   GET /api/apps/:name/deploy?env=           → deployed Quay image + build
    //   GET /api/apps/:name/openshift?env=        → OpenShift deployments + pods
    //   POST /api/apps/:name/refresh              → drop memoized service caches
    if (action === 'jenkins') {
      const p = new URL(req.url).searchParams;
      const limit = Number(p.get('limit'));
      return json(
        await getAppJenkins(app, {
          env: p.get('env') ?? undefined,
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        }),
      );
    }
    if (action === 'deploy') {
      const p = new URL(req.url).searchParams;
      return json(await getAppDeploy(app, { env: p.get('env') ?? undefined }));
    }
    if (action === 'openshift') {
      const p = new URL(req.url).searchParams;
      return json(await getAppOpenshift(app, { env: p.get('env') ?? undefined }));
    }
    if (action === 'refresh') {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      refreshAppCaches();
      return json({ ok: true });
    }
    // GET /api/apps/:name/log[?ref=&limit=] — recent commits; +sha= → that commit's
    //   files; +sha=&path= → one file's diff; +sha=&full=1 → its combined diff.
    if (action === 'log') {
      const p = new URL(req.url).searchParams;
      const sha = p.get('sha');
      if (sha) {
        const path = p.get('path');
        if (path) return json(await getAppCommitFileDiff(app, sha, path));
        if (p.get('full') === '1') return json(await getAppCommitFullDiff(app, sha));
        return json(await getAppCommitFiles(app, sha));
      }
      const limit = Number(p.get('limit'));
      return json(
        await getAppLog(app, {
          ref: p.get('ref') ?? undefined,
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        }),
      );
    }
    // GET /api/apps/:name/branches — list. POST { action: checkout|create|delete|
    //   prune-gone, name?, from? }.
    if (action === 'branches') {
      if (req.method === 'GET') return json(await getAppBranches(app));
      if (req.method === 'POST') {
        let body: { action?: unknown; name?: unknown; from?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonError('invalid JSON body', 400);
        }
        if (!isBranchAction(body.action)) {
          return jsonError('action must be one of checkout|create|delete|prune-gone', 400);
        }
        const name = typeof body.name === 'string' ? body.name : undefined;
        const from = typeof body.from === 'string' ? body.from : undefined;
        return json(await runAppBranchAction(app, { action: body.action, name, from }));
      }
      return jsonError('use GET or POST', 405);
    }
    // POST /api/apps/:name/pr { title?, base?, draft? } — open a PR/MR from the
    //   current branch via the gh/glab CLI (branch must be pushed first).
    if (action === 'pr') {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      let body: { title?: unknown; base?: unknown; draft?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        body = {};
      }
      return json(
        await openAppPr(app, {
          title: typeof body.title === 'string' ? body.title : undefined,
          base: typeof body.base === 'string' ? body.base : undefined,
          draft: body.draft === true,
        }),
      );
    }
    return json(await appDetails(app));
  }

  // POST /api/config — overwrite ~/.rubato/config.json from the Config page editor.
  // Accepts raw `content` (tolerant JSON/JS, parsed here) or a parsed `config`
  // object. Must resolve to a JSON object; secrets stay in ~/.rubato/.env.
  if (pathname === '/api/config' && req.method === 'POST') {
    let body: { content?: unknown; config?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('invalid JSON body', 400);
    }
    let value: unknown = body.config;
    if (typeof body.content === 'string') {
      const parsed = parseLoose(body.content);
      if (!parsed.ok) return jsonError(parsed.error ?? 'config is not valid JSON', 400);
      value = parsed.value;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return jsonError('config must be a JSON object', 400);
    }
    await saveConfig(value as RubatoConfig);
    return json(await loadConfig());
  }

  switch (pathname) {
    case '/api/apps':
      return json(await loadApps());
    case '/api/commands': {
      // Also surface each command's ABSOLUTE script path (the registry `script`
      // is repo-relative) so the UI can offer "open the script in editor", plus
      // its run stats (run count + last run) for the Commands page sorts.
      const stats = new Map(
        getCommandStats()
          .filter((s) => s.scope === 'builtin')
          .map((s) => [s.key, s]),
      );
      return json(
        COMMANDS.map((c) => ({
          ...c,
          scriptPath: resolve(REPO_ROOT, c.script),
          runCount: stats.get(c.name)?.runCount ?? 0,
          lastRunAt: stats.get(c.name)?.lastRunAt,
          tags: c.tags ?? commandTags(c.name),
        })),
      );
    }
    case '/api/config':
      return json(await loadConfig()); // no secrets (those live in ~/.rubato/.env)
    case '/api/runs':
      return json(listRuns());
    case '/api/archives':
      return json(listArchives());
    case '/api/archive': {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      let body: { command?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('invalid JSON body', 400);
      }
      if (!body.command) return jsonError('command required', 400);
      const archive = archiveRun(body.command);
      if (!archive) return jsonError(`no run to archive for "${body.command}"`, 404);
      return json({ archive });
    }
    case '/api/health': {
      const apps = await loadApps();
      return json({ ok: true, apps: apps.length, commands: COMMANDS.length });
    }
    case '/api/health/system': {
      return json(await runSystemHealth());
    }
    // GET /api/health/system/file?path= → read one health-surfaced file inline.
    // Allowlisted to the exact paths the report references (see readSystemHealthFile).
    case '/api/health/system/file': {
      const path = new URL(req.url).searchParams.get('path') ?? '';
      if (!path) return jsonError('path required', 400);
      const result = await readSystemHealthFile(path);
      if (!result.ok) return jsonError(result.error, result.status);
      return json({ name: result.name, content: result.content });
    }
    case '/api/conversations': {
      const app = new URL(req.url).searchParams.get('app') ?? undefined;
      return json(listConversations(app));
    }
    case '/api/ask': {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      let body: {
        app?: string;
        question?: string;
        conversationId?: string;
        attachments?: AskAttachment[];
        fsRoot?: string;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('invalid JSON body', 400);
      }
      if (!body.question?.trim()) return jsonError('question required', 400);
      // app is optional: absent/empty → a general (no-repo) question.
      let app: AppConfig | undefined;
      if (body.app) {
        app = (await resolveAppByName(body.app)) ?? undefined;
        if (!app) return jsonError(`unknown app: ${body.app}`, 404);
      }
      // General mode may point the AI at a folder (read-only fs tools). Validate
      // it's an existing directory; the tool guards then keep reads inside it.
      let fsRoot: string | undefined;
      if (!app && body.fsRoot?.trim()) {
        const expanded = expandPath(body.fsRoot.trim());
        try {
          if (!(await stat(expanded)).isDirectory()) return jsonError(`not a directory: ${body.fsRoot}`, 400);
          fsRoot = expanded;
        } catch {
          return jsonError(`no such directory: ${body.fsRoot}`, 400);
        }
      }
      try {
        // Returns immediately; the answer streams over /ws as ask:* events.
        return json(
          startAsk({
            app,
            question: body.question,
            conversationId: body.conversationId,
            attachments: capAttachments(body.attachments),
            fsRoot,
          }),
          202,
        );
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : 'ask failed', 500);
      }
    }
    case '/api/run': {
      if (req.method !== 'POST') return jsonError('use POST', 405);
      let body: { command?: string; args?: string[]; background?: boolean };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError('invalid JSON body', 400);
      }
      const command = body.command;
      if (!command || !COMMANDS.some((c) => c.name === command)) {
        return jsonError(`unknown command: ${command}`, 400);
      }
      const args = body.args ?? [];
      // Background: return immediately; the result arrives over the socket.
      if (body.background) {
        startBackgroundRun(command, args);
        return json({ accepted: true, command }, 202);
      }
      return json({ run: await runCommand(command, args, Date.now()) });
    }
    default:
      return jsonError(`not found: ${pathname}`, 404);
  }
}

export async function route(req: Request, opts: RouteOptions = {}): Promise<Response> {
  // One correlation id per request — reuse an inbound x-correlation-id (set by a
  // caller / the edge) or mint one with cwip's shared generator (the same id format
  // the sibling apps' cwip/server correlationId middleware uses). Stamp it on every
  // response so a request can be traced end-to-end across logs.
  const correlationId = req.headers.get('x-correlation-id') || makeCorrelationId();
  // Carry the id through the whole async call tree (diagnostics, the log
  // accumulator, captured outbound calls) so a request is traceable by it.
  const response = await runWithCorrelation(correlationId, () => routeRequest(req, opts));
  if (!response.headers.has('x-correlation-id')) {
    // Headers stay mutable on a standard Response until it's sent; guard for the
    // rare body type that disallows it rather than failing the whole request.
    try {
      response.headers.set('x-correlation-id', correlationId);
    } catch {
      // immutable response headers — best-effort, leave the response untouched
    }
  }
  return response;
}

async function routeRequest(req: Request, opts: RouteOptions = {}): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (pathname.startsWith('/api/')) {
    // Central error boundary: any unhandled throw from a handler becomes the
    // canonical error envelope (a thrown AppError keeps its own status).
    try {
      return await handleApi(pathname, req, opts);
    } catch (err) {
      const status = isAppError(err) ? (err.status ?? 500) : 500;
      return jsonError(err instanceof Error ? err.message : String(err), status);
    }
  }

  // Static UI (built) → SPA fallback → single-file explorer. The index (`/` and the
  // SPA fallback) goes through serveIndex so runtime branding can be injected; other
  // assets are served as-is.
  if (pathname !== '/') {
    const asset = await serveStatic(pathname, opts.uiDist);
    if (asset) return asset;
  }
  const index = await serveIndex(opts.uiDist, opts.ui);
  if (index) return index;
  return new Response(UI_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
