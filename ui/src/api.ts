import { ApiError } from "cwip";
import type { ExcelAutomation as ExcelProject } from "cwip/excel-engine/types";
import type { TestArtifact, TestRunReport, TestRunSummary } from "cwip/test-report/types";
import type { TemplateEntry, TemplateEntryStatus, TemplateStatus } from "@shared/appsTemplate";
import type {
  Automation,
  AutomationRunRecord,
  AutomationVariable,
  BrowserChoice,
  DetectedBrowser,
  SessionStatus,
  StepRunnerStatus,
  Target,
} from "@shared/automation";
import type { AutomationEnvironment, EnvVar } from "@shared/automationEnvironment";
import type { EnvDiscoveryQuery, EnvDiscoveryResult } from "@shared/envDiscovery";
import type { RunSpeed } from "@shared/pacing";
import type { Pipeline, PipelineRunRecord, PipelineVariable, ScriptInfo, ScriptParamValues } from "@shared/pipeline";
import type { Environment, HttpRequest, HttpResult, KV, SavedRequest } from "@shared/request/model";
import type {
  BackupInfo,
  DbStats,
  QueryRequest,
  QueryResult,
  RestoreResult,
  TableInfo,
  UiConfigPatch,
  UiState,
} from "@shared/ui";
import type {
  AppDetails,
  ArchiveRecord,
  AskAccepted,
  AskAttachment,
  CommandArg,
  CommandExample,
  CommandFlag,
  CommandMeta,
  Conversation,
  ConversationDetail,
  DiagnosticSummary,
  IndexStatus,
  OutputFile,
  RunHistoryRecord,
  RunRecord,
  SaveCommand,
  SaveCron,
  SavedCommand,
  SaveCurlRequest,
  SavedCron,
  SavedCurlRequest,
  SavedRegex,
  SaveRegex,
  ServiceInfo,
  ServiceRunRequest,
  ServiceRunResponse,
  SplunkAppInfo,
  SplunkQueryRequest,
  SplunkQueryResponse,
  SplunkRunRequest,
  SplunkRunResponse,
  SplunkStatus,
  SystemFileDoc,
  SystemFileInfo,
} from "@shared/types";

export type { ArchiveRecord, CommandArg, CommandExample, CommandFlag, OutputFile, RunRecord };
export type {
  BackupInfo,
  ColumnInfo,
  DbStats,
  FilterOp,
  QueryFilter,
  QueryRequest,
  QueryResult,
  RestoreResult,
  TableInfo,
  TableStat,
  UiConfigPatch,
  UiPage,
  UiState,
} from "@shared/ui";
export { UI_PAGES } from "@shared/ui";
export type { RunHistoryRecord, SaveCommand, SavedCommand, SavedCommandKind } from "@shared/types";
export type {
  Automation,
  AutomationRunRecord,
  AutomationVariable,
  Step,
  StepResult,
  StepRunnerStatus,
  Target,
} from "@shared/automation";
export type { AppDetails, AppGitStatus, AppReadme, AppSources } from "@shared/types";
export type {
  AskAccepted,
  AskAttachment,
  AskSource,
  ChatMessage,
  Conversation,
  ConversationDetail,
  IndexState,
  IndexStatus,
  MessageTrace,
  SaveCron,
  SaveCurlRequest,
  SavedCron,
  SavedCurlRequest,
  SavedRegex,
  SaveRegex,
  ServiceInfo,
  ServiceOperationInfo,
  ServiceParamInfo,
  ServiceRunRequest,
  ServiceRunResponse,
  SplunkAppInfo,
  SplunkQueryRequest,
  SplunkQueryResponse,
  SplunkRunRequest,
  SplunkRunResponse,
  SplunkSearchInfo,
  SplunkStatus,
  ToolEvent,
  TraceStep,
} from "@shared/types";

export interface AppLink {
  text: string;
  href: string;
}

export interface AppConfig {
  name: string;
  absolutePath: string;
  group: string | null;
  aliases: string[];
  dirName?: string;
  repoName?: string;
  packageJsonName?: string;
  apis?: Array<{ name: string; [key: string]: unknown }>;
  /** Databases the app uses (free-form strings; common ones in DB_SUGGESTIONS). */
  db?: string[];
  /** User-added free-form tech tags beyond db/apis/cloneUrl. */
  tags?: string[];
  links?: AppLink[];
  cloneUrl?: string;
  managed?: boolean;
  pinned?: boolean;
  missing?: boolean;
  [key: string]: unknown;
}

export interface Command extends CommandMeta {
  name: string;
  description: string;
  kind: string;
  /** Script path relative to the repo root (from the registry). */
  script?: string;
  /** Absolute path to the script (resolved server-side) — for "open in editor". */
  scriptPath?: string;
  /** Whether runs of this command are captured/recorded (defaults true for plain). */
  capture?: boolean;
  /** Times this command has been run (from command_stats), if ever. */
  runCount?: number;
  /** Unix ms of the most recent run, if ever. */
  lastRunAt?: number;
  // `tags` is inherited from CommandMeta.
}

/** The on-disk script backing a command — shown on its detail page. */
export interface CommandSource {
  name: string;
  script: string;
  source: string;
}

// Canonical message from a failed-response body — reads the standard
// `{ error: { message } }` envelope, and tolerates a legacy bare-string `error`.
const errMessage = (data: any): string | undefined =>
  typeof data?.error === "string" ? data.error : data?.error?.message;

// The one typed error for a failed request: a cwip ApiError carrying status/code
// (parsed from the envelope) + extractMessage()/isClientError() etc.
const apiError = (res: Response, data: unknown): ApiError =>
  new ApiError({
    client: "rubato",
    status: res.status,
    statusText: res.statusText,
    url: res.url,
    method: "",
    body: data,
  });

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw apiError(res, await res.json().catch(() => null));
  return res.json() as Promise<T>;
}

/** One universal-search hit (server-built; `href` points at the owning page). */
export interface SearchHit {
  id: string;
  title: string;
  snippet?: string;
  sub?: string;
  href: string;
}
/** Search hits grouped by entity type (Commands, Board, Tools, …). */
export interface SearchGroup {
  key: string;
  label: string;
  href: string;
  items: SearchHit[];
}
/** Universal content search across the user-authored items. */
export const fetchSearch = (q: string) =>
  getJson<{ groups: SearchGroup[] }>(`/api/search?q=${encodeURIComponent(q)}`);

// Test Reports — functional/e2e run reports the runner wrote (cwip TestRunReport).
export const fetchTestReportSummaries = () =>
  getJson<{ reports: TestRunSummary[] }>("/api/test-reports").then((r) => r.reports);
export const fetchTestReport = (id: string) =>
  getJson<{ report: TestRunReport }>(`/api/test-reports/${encodeURIComponent(id)}`).then((r) => r.report);
export const testReportArtifactUrl = (id: string, a: TestArtifact) =>
  `/api/test-reports/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(a.path?.split("/").pop() ?? a.name)}`;

export const fetchApps = () => getJson<AppConfig[]>("/api/apps");
/** Clone a repo to a location and register it; returns the new app config. */
export const cloneApp = (body: { url: string; dest: string; name?: string; group?: string }) =>
  postJson<AppConfig>("/api/apps/clone", body);
/** Backfill cloneUrl from each git-repo app's origin remote where missing. */
export const fillGitUrls = () =>
  postJson<{ filled: Array<{ name: string; cloneUrl: string }>; count: number }>("/api/apps/fill-git-urls", {});
/** List subdirectories of a path for the folder-picker UI. */
export interface BrowseDirResult {
  path: string;
  dirs: string[];
  home: string;
}
export const browseDir = (path: string) =>
  getJson<BrowseDirResult>(`/api/browse?path=${encodeURIComponent(path)}`);

export interface ScanResult {
  reposFound: number;
  newApps: AppConfig[];
  updatedCount: number;
  pinnedCount: number;
  missingApps: AppConfig[];
  removedCount: number;
  conflicts: Array<{ kind: string; key: string; apps: Array<{ name: string; path: string }> }>;
  dryRun: boolean;
}
/** Run the full recursive rubato-scan across all configured codeDirs. */
export const runAppsScan = (dryRun = false) =>
  postJson<ScanResult>("/api/apps/run-scan", { dryRun });
/** Replace the codeDirs list in config (each entry expanded server-side). */
export const setCodeDirs = (dirs: string[]) =>
  patchJson<{ codeDirs: string[] }>("/api/config/code-dirs", { dirs });
export const fetchAppDetails = (name: string) =>
  getJson<AppDetails>(`/api/apps/${encodeURIComponent(name)}/details`);
/** Open an app's directory in the configured editor (uses gotab's mechanism server-side). */
export const openApp = (name: string) =>
  postJson<{ editor: string; path: string }>(`/api/apps/${encodeURIComponent(name)}/open`, {});
/**
 * Open ANY file/dir in the configured editor (gotab's mechanism for an arbitrary
 * path). Backs the "open in editor" buttons shown wherever the UI displays a
 * filesystem path. `~`/absolute paths open as-is; relative paths resolve against
 * the output dir (the Files tab + diagnostics). Returns the editor + resolved path.
 */
export const openPath = (path: string) =>
  postJson<{ editor: string; path: string }>("/api/open", { path });
/** Set an app's shortcut links; returns the updated app config. */
export const saveAppLinks = (name: string, links: AppLink[]) =>
  postJson<AppConfig>(`/api/apps/${encodeURIComponent(name)}/links`, { links });
/** Set an app's database list; returns the updated app config. */
export const saveAppDb = (name: string, db: string[]) =>
  postJson<AppConfig>(`/api/apps/${encodeURIComponent(name)}/db`, { db });
/** Set an app's free-form tech tags; returns the updated app config. */
export const saveAppTechTags = (name: string, tags: string[]) =>
  postJson<AppConfig>(`/api/apps/${encodeURIComponent(name)}/tech-tags`, { tags });
/** Detected db tags inferred from the app's package.json drivers. */
export interface DetectedTech {
  dbs: string[];
  sources: { pkg: string; tag: string }[];
}
/** Suggest db tags from the app's package.json (read live, never written). */
export const detectAppTech = (name: string) =>
  getJson<DetectedTech>(`/api/apps/${encodeURIComponent(name)}/detect-tech`);
/** Common database choices offered as suggestions in the db editor (custom allowed). */
export const DB_SUGGESTIONS = ["mongodb", "postgres", "mysql", "mssql", "sqlite", "redis", "oracle"];

/** One discovered .env* file in an app directory. */
export interface EnvFileInfo {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
}
/** List an app's discovered .env* files. */
export const fetchAppEnvFiles = (name: string) =>
  getJson<EnvFileInfo[]>(`/api/apps/${encodeURIComponent(name)}/env-files`);
/** Read one env file's text + info. */
export const fetchAppEnvFile = (name: string, path: string) =>
  getJson<{ ok: true; info: EnvFileInfo; content: string }>(
    `/api/apps/${encodeURIComponent(name)}/env-files?path=${encodeURIComponent(path)}`,
  );
/** Write one env file's text to disk. */
export const saveAppEnvFile = (name: string, path: string, content: string) =>
  postJson<{ ok: true; info: EnvFileInfo }>(`/api/apps/${encodeURIComponent(name)}/env-files`, { path, content });
/** Search/discover .env* keys across every app (which apps have/lack a key, by group/all). */
export const fetchEnvDiscovery = (query: EnvDiscoveryQuery) => {
  const sp = new URLSearchParams();
  if (query.group) sp.set("group", query.group);
  if (query.q) sp.set("q", query.q);
  if (query.value) sp.set("value", query.value);
  if (query.mode) sp.set("mode", query.mode);
  const qs = sp.toString();
  return getJson<EnvDiscoveryResult>(`/api/env-discovery${qs ? `?${qs}` : ""}`);
};
/** Unregister an app — remove its entry from apps.json. Files on disk are left untouched. */
export async function deleteApp(name: string): Promise<void> {
  const res = await fetch(`/api/apps/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) throw apiError(res, await res.json().catch(() => null));
}

// ── Apps template (shared, repo-tracked apps.template.json with <HOME> paths) ──
export type { TemplateEntry, TemplateEntryStatus, TemplateGit, TemplateStatus } from "@shared/appsTemplate";
/** The shared template, every entry annotated with applied/path-exists status for this machine. */
export const fetchAppsTemplate = () => getJson<TemplateStatus>("/api/apps/template");
/** Add chosen template entries to the local registry (resolving <HOME>). */
export const applyTemplateEntries = (names: string[]) =>
  postJson<{ added: string[]; skipped: { name: string; reason: string }[] }>("/api/apps/template/apply", { names });
/** Save chosen registry apps into the template (home-tokenized). */
export const addAppsToTemplate = (names: string[]) =>
  postJson<{ added: string[]; template: TemplateEntry[] }>("/api/apps/template/add", { names });
/** Remove entries from the template by name. */
export const removeTemplateEntries = (names: string[]) =>
  postJson<{ removed: string[]; template: TemplateEntry[] }>("/api/apps/template/remove", { names });
/** Add new hand-authored entries (parsed from pasted JS/JSON) to the template. */
export const createTemplateEntries = (entries: TemplateEntry[]) =>
  postJson<{
    added: string[];
    skipped: { name: string; reason: string }[];
    missingPaths: string[];
    template: TemplateEntry[];
  }>("/api/apps/template/create", { entries });
/** Replace one template entry in place (rename allowed). */
export const editTemplateEntry = (originalName: string, entry: TemplateEntry) =>
  postJson<{ ok: boolean; error?: string; updated?: string; pathExists?: boolean; template: TemplateEntry[] }>(
    "/api/apps/template/edit",
    { originalName, entry },
  );
/** Sort the template's entries alphabetically by name. */
export const sortTemplate = () => postJson<{ template: TemplateEntry[] }>("/api/apps/template/sort", {});
/** Set the per-machine hidden-template set (empty list restores all). */
export const setHiddenTemplates = (names: string[]) =>
  postJson<{ hidden: string[] }>("/api/apps/template/hidden", { names });
/** Git-commit just the template file (local only — never pushes). */
export const commitTemplate = (message?: string) =>
  postJson<{ ok: boolean; committed: boolean; output?: string; error?: string }>("/api/apps/template/commit", {
    message,
  });
/** Unified git diff of the template file vs its last commit (for review-before-commit). */
export const fetchAppsTemplateDiff = () => getJson<{ diff: string }>("/api/apps/template/diff");

export type AppGitAction = "pull" | "fetch" | "checkoutDefault" | "commitAll" | "push";
export interface AppGitResult {
  ok: boolean;
  action: AppGitAction;
  branch?: string;
  output?: string;
  error?: string;
}
/** Run a per-app git quick-action (commit-all / checkout-default / pull / fetch). */
export const runAppGit = (name: string, action: AppGitAction, message?: string) =>
  postJson<AppGitResult>(`/api/apps/${encodeURIComponent(name)}/git`, { action, message });

export type DiffStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";
export interface DiffFile {
  path: string;
  status: DiffStatus;
  untracked: boolean;
}
/** What the working tree is diffed against. */
export type DiffBase = "head" | "main" | "origin-main";
export interface AppDiffSummary {
  ok: boolean;
  files: DiffFile[];
  base?: DiffBase;
  baseRef?: string;
  defaultBranch?: string;
  hasOriginDefault?: boolean;
  error?: string;
}
export type AppDiffAction = "stash" | "discardAll" | "discard" | "commit";
const baseQ = (base?: DiffBase) => (base && base !== "head" ? `base=${base}` : "");
/** List an app's changed files vs `base` (default head = uncommitted). */
export const fetchAppDiff = (name: string, base: DiffBase = "head") =>
  getJson<AppDiffSummary>(`/api/apps/${encodeURIComponent(name)}/diff?${baseQ(base)}`);
/** A unified diff for one changed file vs `base`. */
export const fetchAppFileDiff = (name: string, path: string, untracked: boolean, base: DiffBase = "head") =>
  getJson<{ path: string; diff: string }>(
    `/api/apps/${encodeURIComponent(name)}/diff?path=${encodeURIComponent(path)}${
      untracked ? "&untracked=1" : ""
    }&${baseQ(base)}`,
  );
/** One combined unified diff of every change vs `base`. */
export const fetchAppFullDiff = (name: string, base: DiffBase = "head") =>
  getJson<{ diff: string }>(`/api/apps/${encodeURIComponent(name)}/diff?full=1&${baseQ(base)}`);
/** Stash / discard / commit specific paths (commit needs a message); returns new files. */
export const runAppDiff = (name: string, action: AppDiffAction, paths?: string[], message?: string) =>
  postJson<AppDiffSummary>(`/api/apps/${encodeURIComponent(name)}/diff`, { action, paths, message });

// ── Commit log + commit diffs ──────────────────────────────────────────────────
export interface AppCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  email: string;
  relativeDate: string;
  date: string;
}
/** Recent commits on the app's current branch (or a given ref). */
export const fetchAppLog = (name: string, ref?: string, limit?: number) =>
  getJson<{ ok: boolean; commits: AppCommit[]; error?: string }>(
    `/api/apps/${encodeURIComponent(name)}/log?${ref ? `ref=${encodeURIComponent(ref)}&` : ""}${
      limit ? `limit=${limit}` : ""
    }`,
  );
const logShaBase = (name: string, sha: string) => `/api/apps/${encodeURIComponent(name)}/log?sha=${encodeURIComponent(sha)}`;
/** Files a commit changed. */
export const fetchAppCommitFiles = (name: string, sha: string) =>
  getJson<{ ok: boolean; files: DiffFile[]; error?: string }>(logShaBase(name, sha));
/** A unified diff of one file as a commit changed it. */
export const fetchAppCommitFileDiff = (name: string, sha: string, path: string) =>
  getJson<{ path: string; diff: string }>(`${logShaBase(name, sha)}&path=${encodeURIComponent(path)}`);
/** A commit's whole combined diff. */
export const fetchAppCommitFullDiff = (name: string, sha: string) =>
  getJson<{ diff: string }>(`${logShaBase(name, sha)}&full=1`);

// ── Branches ───────────────────────────────────────────────────────────────────
export interface AppBranch {
  name: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  gone: boolean;
}
export type BranchAction = "checkout" | "create" | "delete" | "prune-gone";
export interface BranchActionResult {
  ok: boolean;
  action: BranchAction;
  branch?: string;
  removed?: string[];
  output?: string;
  error?: string;
}
/** List the app's local branches with upstream tracking (ahead/behind, gone). */
export const fetchAppBranches = (name: string) =>
  getJson<{ ok: boolean; current?: string; branches: AppBranch[]; error?: string }>(
    `/api/apps/${encodeURIComponent(name)}/branches`,
  );
/** checkout / create / delete / prune-gone a branch. */
export const runAppBranch = (name: string, body: { action: BranchAction; name?: string; from?: string }) =>
  postJson<BranchActionResult>(`/api/apps/${encodeURIComponent(name)}/branches`, body);

// ── Pull / merge requests (gh + glab CLIs) ─────────────────────────────────────
export interface OpenPrResult {
  ok: boolean;
  host?: "github" | "gitlab";
  url?: string;
  output?: string;
  error?: string;
}
/** Open a PR/MR from the app's current branch (branch must be pushed first). */
export const openAppPr = (name: string, body: { title?: string; base?: string; draft?: boolean }) =>
  postJson<OpenPrResult>(`/api/apps/${encodeURIComponent(name)}/pr`, body);

// ── Stashes ───────────────────────────────────────────────────────────────────
export interface StashEntry {
  ref: string;
  index: number;
  message: string;
  relativeDate?: string;
  date?: string;
}
/** Diff a stash either as its own captured changes, or against the current tree. */
export type StashDiffMode = "stash" | "worktree";
export type StashAction = "drop" | "clear" | "apply" | "pop" | "undo";
export interface StashActionResult {
  ok: boolean;
  action: StashAction;
  conflicted?: boolean;
  conflictedFiles?: string[];
  popped?: boolean;
  undoToken?: string | null;
  output?: string;
  error?: string;
}
const stashBase = (name: string) => `/api/apps/${encodeURIComponent(name)}/stash`;
/** List an app's stash entries (newest first). */
export const fetchAppStashes = (name: string) =>
  getJson<{ ok: boolean; stashes: StashEntry[]; error?: string }>(stashBase(name));
/** Files changed in a stash, in the requested mode. */
export const fetchAppStashFiles = (name: string, ref: string, mode: StashDiffMode) =>
  getJson<{ ok: boolean; files: DiffFile[]; error?: string }>(
    `${stashBase(name)}?ref=${encodeURIComponent(ref)}&mode=${mode}`,
  );
/** One file's diff within a stash, in the requested mode. */
export const fetchAppStashFileDiff = (name: string, ref: string, path: string, mode: StashDiffMode) =>
  getJson<{ path: string; diff: string }>(
    `${stashBase(name)}?ref=${encodeURIComponent(ref)}&mode=${mode}&path=${encodeURIComponent(path)}`,
  );
/** A stash's whole combined diff, in the requested mode. */
export const fetchAppStashFullDiff = (name: string, ref: string, mode: StashDiffMode) =>
  getJson<{ diff: string }>(`${stashBase(name)}?ref=${encodeURIComponent(ref)}&mode=${mode}&full=1`);
/** drop one / clear all / apply / pop / undo a conflicted apply. */
export const runAppStash = (name: string, body: { action: StashAction; ref?: string; undoToken?: string | null }) =>
  postJson<StashActionResult>(stashBase(name), body);

// ── Tags ────────────────────────────────────────────────────────────────────
export interface AppTag {
  name: string;
  commit: string;
  subject?: string;
  date?: string;
  annotated: boolean;
  message?: string;
}
export type TagAction = "checkout" | "delete";
export interface TagActionResult {
  ok: boolean;
  action: TagAction;
  branch?: string;
  output?: string;
  error?: string;
}
const tagsBase = (name: string) => `/api/apps/${encodeURIComponent(name)}/tags`;
/** List an app's tags with metadata (target commit/subject, date, annotation). */
export const fetchAppTags = (name: string) =>
  getJson<{ ok: boolean; tags: AppTag[]; error?: string }>(tagsBase(name));
/** Create a tag (annotated when `message` set) on `ref` (default HEAD). */
export const createAppTag = (
  name: string,
  body: { name: string; ref?: string; message?: string; force?: boolean },
) => postJson<{ ok: boolean; error?: string }>(tagsBase(name), { action: "create", ...body });
/** Check out a tag (detached HEAD) or delete it. */
export const runAppTag = (name: string, action: TagAction, tagName: string) =>
  postJson<TagActionResult>(tagsBase(name), { action, name: tagName });

// ── Per-app cross-domain data (Jenkins / deploy / OpenShift) ───────────────────
const envQ = (env?: string) => (env ? `?env=${encodeURIComponent(env)}` : "");

export interface AppJenkinsBuildRow {
  number: number;
  status: string;
  building: boolean;
  branch: string | null;
  commit: string | null;
  url: string;
  timestamp: number;
  durationMs?: number;
}
export interface AppJenkins {
  ok: boolean;
  jobPath?: string;
  builds: AppJenkinsBuildRow[];
  error?: string;
}
/** Recent Jenkins builds for an app's job (env selects the per-env job). */
export const fetchAppJenkins = (name: string, env?: string) =>
  getJson<AppJenkins>(`/api/apps/${encodeURIComponent(name)}/jenkins${envQ(env)}`);

export interface AppDeploy {
  ok: boolean;
  configured: boolean;
  version?: string;
  imageSha?: string;
  imageDigest?: string;
  commit?: string;
  buildNumber?: number;
  publishedAt?: string;
  env?: string;
  error?: string;
}
/** The app's deployed Quay image (version + sha) joined with its latest build. */
export const fetchAppDeploy = (name: string, env?: string) =>
  getJson<AppDeploy>(`/api/apps/${encodeURIComponent(name)}/deploy${envQ(env)}`);

export interface AppOpenshiftDeployment {
  name: string;
  replicas: number;
  ready: number;
  available: number;
  updated: number;
  isAvailable: boolean;
  image?: string;
  createdAt?: string;
  updatedAt?: string;
}
export interface AppPodSummary {
  total: number;
  running: number;
  pending: number;
  failed: number;
  notReady: number;
  restarts: number;
  problematic: { name: string; reason: string }[];
}
export interface AppOpenshift {
  ok: boolean;
  namespace?: string;
  deployments: AppOpenshiftDeployment[];
  pods?: AppPodSummary;
  error?: string;
}
/** OpenShift deployments + pod roll-up for the app's namespace (per env). */
export const fetchAppOpenshift = (name: string, env?: string) =>
  getJson<AppOpenshift>(`/api/apps/${encodeURIComponent(name)}/openshift${envQ(env)}`);

/** Drop the server's memoized service caches so the next reads are fresh. */
export const refreshApp = (name: string) =>
  postJson<{ ok: boolean }>(`/api/apps/${encodeURIComponent(name)}/refresh`, {});

export const fetchCommands = () => getJson<Command[]>("/api/commands");
export const fetchCommandSource = (name: string) =>
  getJson<CommandSource>(`/api/commands/${encodeURIComponent(name)}/source`);
export const fetchRuns = () => getJson<RunRecord[]>("/api/runs");
export const fetchArchives = () => getJson<ArchiveRecord[]>("/api/archives");
export const fetchConfig = () => getJson<Record<string, unknown>>("/api/config");
/** Overwrite ~/.rubato/config.json from the Config page (tolerant JSON/JS text). */
export const saveConfig = (content: string) =>
  postJson<Record<string, unknown>>("/api/config", { content });

// ── Web-UI page enablement + Admin (backups + DB viewer) ─────────────────────

export const fetchUi = () => getJson<UiState>("/api/ui");
export const saveUi = (patch: UiConfigPatch) => postJson<UiState>("/api/ui", patch);

// System Health — mirrors cwip/health's HealthReport (GET /api/health/system).
export type SystemHealthStatus = "ok" | "info" | "warn" | "error";
/** A filesystem path a check refers to, surfaced so the UI can open/view it. */
export interface SystemHealthPath {
  label: string;
  path: string;
  kind: "file" | "dir";
  exists: boolean;
}
export interface SystemHealthResult {
  id: string;
  title: string;
  category: string;
  severity: "error" | "warn" | "info";
  status: SystemHealthStatus;
  detail: string;
  remediation: string[];
  paths?: SystemHealthPath[];
}
export interface SystemHealthReport {
  results: SystemHealthResult[];
  summary: { error: number; warn: number; info: number; ok: number };
  checkedAt: string;
  ok: boolean;
}
export const fetchSystemHealth = () => getJson<SystemHealthReport>("/api/health/system");
/** Read one health-surfaced file's contents for the inline viewer (allowlisted server-side). */
export const fetchSystemHealthFile = (path: string) =>
  getJson<{ name: string; content: string }>(`/api/health/system/file?path=${encodeURIComponent(path)}`);

// Backups
export const fetchBackups = () => getJson<BackupInfo[]>("/api/admin/backups");
export const createBackup = () => postJson<BackupInfo>("/api/admin/backups", {});
export async function deleteBackup(fileName: string): Promise<void> {
  const res = await fetch(`/api/admin/backups/${encodeURIComponent(fileName)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}
export const backupDownloadUrl = (fileName: string) => `/api/admin/backups/${encodeURIComponent(fileName)}/download`;
export const fetchBackupTables = (fileName: string) =>
  getJson<TableInfo[]>(`/api/admin/backups/${encodeURIComponent(fileName)}/tables`);
export const queryBackupTable = (fileName: string, table: string, body: QueryRequest) =>
  postJson<QueryResult>(
    `/api/admin/backups/${encodeURIComponent(fileName)}/tables/${encodeURIComponent(table)}/query`,
    body,
  );
export const restoreBackup = (fileName: string, tables: string[]) =>
  postJson<RestoreResult>(`/api/admin/backups/${encodeURIComponent(fileName)}/restore`, { tables });

// Live DB viewer
export const fetchDbTables = () => getJson<TableInfo[]>("/api/admin/db/tables");
export const fetchDbStats = () => getJson<DbStats>("/api/admin/db/stats");
export const queryDbTable = (table: string, body: QueryRequest) =>
  postJson<QueryResult>(`/api/admin/db/tables/${encodeURIComponent(table)}/query`, body);

// ── Script-output files (Files tab + Runs page viewer) ───────────────────────

export const fetchFiles = () => getJson<OutputFile[]>("/api/files");

/** Read one output file's text by path (relative to the output dir, or absolute). */
export async function fetchFileContent(path: string): Promise<{ file: OutputFile; content: string }> {
  const res = await fetch(`/api/files/content?path=${encodeURIComponent(path)}`);
  const data = (await res.json()) as { file?: OutputFile; content?: string; error?: string };
  if (!res.ok || data.file === undefined) throw new Error(errMessage(data) ?? `read failed → ${res.status}`);
  return { file: data.file, content: data.content ?? "" };
}

/** Download URL for an output file (streams as an attachment). */
export const fileDownloadUrl = (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`;

// ── Diagnostics (admin) ──────────────────────────────────────────────────────

export type { DiagnosticSummary };

/** Parsed summaries of every diagnostic report (admin Diagnostics panel). */
export const fetchDiagnostics = () => getJson<DiagnosticSummary[]>("/api/admin/diagnostics");

/** Read one diagnostic artifact (report or log) by its diagnostics/ path. */
export async function fetchDiagnosticContent(path: string): Promise<{ file: OutputFile; content: string }> {
  const res = await fetch(`/api/admin/diagnostics/content?path=${encodeURIComponent(path)}`);
  const data = (await res.json()) as { file?: OutputFile; content?: string; error?: string };
  if (!res.ok || data.file === undefined) throw new Error(errMessage(data) ?? `read failed → ${res.status}`);
  return { file: data.file, content: data.content ?? "" };
}

/** Download URL for a diagnostic artifact (streams as an attachment). */
export const diagnosticDownloadUrl = (path: string) => `/api/admin/diagnostics/download?path=${encodeURIComponent(path)}`;

// ── Repo docs (markdown viewer) ──────────────────────────────────────────────

export const fetchDocs = () => getJson<string[]>("/api/docs");

export async function fetchDoc(name: string): Promise<string> {
  const res = await fetch(`/api/docs/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`/api/docs/${name} → ${res.status}`);
  return res.text();
}

// ── Editable system files (CLAUDE.md, shell rc files, git config — Docs hub) ───

export type { SystemFileDoc, SystemFileInfo } from "@shared/types";

export const fetchSystemFiles = () => getJson<SystemFileInfo[]>("/api/system-files");
export const fetchSystemFile = (key: string) => getJson<SystemFileDoc>(`/api/system-files/${encodeURIComponent(key)}`);
export const saveSystemFile = (key: string, content: string) =>
  postJson<SystemFileDoc>(`/api/system-files/${encodeURIComponent(key)}`, { content });

export async function archiveRun(command: string): Promise<ArchiveRecord> {
  const res = await fetch("/api/archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command }),
  });
  const data = (await res.json()) as { archive?: ArchiveRecord; error?: string };
  if (!res.ok || !data.archive) throw new Error(errMessage(data) ?? "archive failed");
  return data.archive;
}

export async function deleteArchive(id: number): Promise<void> {
  const res = await fetch(`/api/archives/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

export async function runCommand(command: string, args: string[]): Promise<RunRecord> {
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const data = (await res.json()) as { run?: RunRecord; error?: string };
  if (!res.ok || !data.run) throw new Error(errMessage(data) ?? "run failed");
  return data.run;
}

// ── Run history + saved commands ─────────────────────────────────────────────

/** Every recorded run, optionally for one command (latest first). */
export const fetchRunHistory = (command?: string) =>
  getJson<RunHistoryRecord[]>(`/api/runs/history${command ? `?command=${encodeURIComponent(command)}` : ""}`);

export const fetchSavedCommands = () => getJson<SavedCommand[]>("/api/commands/saved");

export const saveCommand = (c: SaveCommand) => postJson<SavedCommand>("/api/commands/saved", c);

export async function deleteSavedCommand(id: string): Promise<void> {
  const res = await fetch(`/api/commands/saved/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

export async function runSavedCommand(id: string): Promise<RunRecord> {
  const res = await fetch(`/api/commands/saved/${encodeURIComponent(id)}/run`, { method: "POST" });
  const data = (await res.json()) as { run?: RunRecord; error?: string };
  if (!res.ok || !data.run) throw new Error(errMessage(data) ?? "run failed");
  return data.run;
}

// ── Playwright automation builder ───────────────────────────────────────────

async function sendJson<T>(method: string, url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: unknown };
  if (!res.ok) throw apiError(res, data);
  return data;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return sendJson<T>("POST", url, body);
}
function patchJson<T>(url: string, body: unknown): Promise<T> {
  return sendJson<T>("PATCH", url, body);
}

// ── Capture artifacts (the Browser builder's capture track) ──────────────────
// The live capture session is part of the unified build session above
// (sessionCapture / sessionSnapshot / sessionStatus); these are the stored-artifact
// reads, lifts, exports, and imports.

import type { CaptureManifest, CaptureSummary } from "@shared/capture";

export type { CaptureManifest, CaptureRecord, CaptureSummary } from "@shared/capture";

export const fetchCaptures = () => getJson<CaptureSummary[]>("/api/capture");
export const fetchCaptureManifest = (id: string) => getJson<CaptureManifest>(`/api/capture/${encodeURIComponent(id)}`);
/** Lift a capture into an unsaved, editable builder draft (keeps a capture-track ref). */
export const fetchCaptureDraft = (id: string) =>
  getJson<Pick<Automation, "name" | "description" | "startUrl" | "steps" | "capture">>(
    `/api/capture/${encodeURIComponent(id)}/draft`,
  );
export async function deleteCapture(id: string): Promise<void> {
  const res = await fetch(`/api/capture/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}
/** Edit a stored session's label / description; returns the updated summary. */
export const updateCapture = (id: string, patch: { label?: string; note?: string }) =>
  patchJson<CaptureSummary>(`/api/capture/${encodeURIComponent(id)}`, patch);
/** Export a session as a compact shareable STRING (sealed with `seed` when given). */
export const exportCaptureText = (id: string, seed?: string) =>
  postJson<{ token: string }>(`/api/capture/${encodeURIComponent(id)}/export-text`, { seed });
/** Import a shared bundle STRING (a sealed token needs its seed) → its summary. */
export const importCaptureText = (token: string, seed?: string) =>
  postJson<CaptureSummary>("/api/capture/import-text", { token, seed });
/** Download URL for a session's shippable gzip bundle (file fallback). */
export const captureExportUrl = (id: string) => `/api/capture/${encodeURIComponent(id)}/export`;
/** Inline URL for one artifact (HTML sandboxed / screenshot image). */
export const captureArtifactUrl = (id: string, path: string) =>
  `/api/capture/${encodeURIComponent(id)}/artifact?path=${encodeURIComponent(path)}`;
/** Save a recorded capture as a rerunnable Automation (returns the saved automation).
 *  `smartWaits` (not "off") bakes in watch-pacing waits so the replay is followable. */
export const saveCaptureAsAutomation = (id: string, name?: string, smartWaits?: RunSpeed) =>
  postJson<Automation>(`/api/capture/${encodeURIComponent(id)}/automation`, { name, smartWaits });
/** Import a shipped bundle file (raw gzip bytes) → its summary. */
export async function importCapture(file: File | Blob): Promise<CaptureSummary> {
  const res = await fetch("/api/capture/import", {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: await file.arrayBuffer(),
  });
  const data = (await res.json()) as CaptureSummary & { error?: string };
  if (!res.ok) throw new Error(errMessage(data) ?? `import → ${res.status}`);
  return data;
}

// ── Debug logs (a request's server logs + the outbound API/DB calls it made) ──
import type { DebugCaptureRecord } from "@shared/debugCapture";

export type { DebugCaptureRecord } from "@shared/debugCapture";

/** One buffered server log line (mirrors lib/logAccumulator's LogLine). */
export interface DebugLogLine {
  ts: string;
  level: string;
  msg: string;
  activity?: string;
}
export interface DebugLogsResponse {
  correlationId: string;
  logs: DebugLogLine[];
  captures: DebugCaptureRecord[];
}
/** Everything recorded for one request (by correlation id): server logs + calls. */
export const fetchDebugLogs = (correlationId: string) =>
  getJson<DebugLogsResponse>(`/api/debug-capture/logs?correlationId=${encodeURIComponent(correlationId)}`);

export const fetchAutomations = () => getJson<Automation[]>("/api/automations");
export const fetchAutomation = (id: string) => getJson<Automation>(`/api/automations/${id}`);
export const fetchAutomationRuns = (automation?: string) =>
  getJson<AutomationRunRecord[]>(`/api/automation-runs${automation ? `?automation=${encodeURIComponent(automation)}` : ""}`);

export const saveAutomation = (a: Partial<Automation> & { name: string; steps: Automation["steps"] }) =>
  postJson<Automation>("/api/automations", a);

/** (Re)derive a saved automation's steps from its capture track and persist them.
 *  Recovers a captured flow that ended up with screenshots but no steps. */
export const generateStepsFromCapture = (id: string) =>
  postJson<{ automation: Automation; generated: number }>(
    `/api/automations/${encodeURIComponent(id)}/steps-from-capture`,
    {},
  );

export async function deleteAutomation(id: string): Promise<void> {
  const res = await fetch(`/api/automations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

/** Delete one run (DB row + its on-disk outputs: screenshots/HTML/shots/run dir). */
export async function deleteAutomationRun(id: number): Promise<void> {
  const res = await fetch(`/api/automation-runs/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

/** Delete all run outputs (optionally just one automation's); returns how many. */
export const clearAutomationRuns = (automation?: string) =>
  postJson<{ deleted: number }>("/api/automation-runs/cleanup", automation ? { automation } : {});

/** Variables a run needs, each flagged set-in-env or not (never the value). */
export const fetchAutomationVariables = (id: string) =>
  getJson<{ variables: AutomationVariable[] }>(`/api/automations/${encodeURIComponent(id)}/variables`).then(
    (r) => r.variables,
  );

export const runAutomation = (payload: {
  id?: string;
  automation?: Automation;
  headless?: boolean;
  keepOpen?: boolean;
  speed?: RunSpeed;
  browser?: BrowserChoice;
  variables?: Record<string, string>;
  /** Fan the automation out across these URLs (one parallel window each). */
  urls?: string[];
  /** Fan out one run per row of variables (a matrix); a `url` column overrides startUrl. */
  rows?: Record<string, string>[];
}) =>
  postJson<{ accepted: true; automation: string; targetCount?: number; skipped?: number }>(
    "/api/automations/run",
    payload,
  );

/** Close the browser left open after a headed run (failed, or kept open on request). */
export const closeAutomationBrowser = () => postJson<{ ok: true }>("/api/automations/close-browser", {});

// ── Automation environments (Postman-style named variable sets) ──
export type { AutomationEnvironment, EnvVar };
export const fetchAutomationEnvironments = () =>
  getJson<AutomationEnvironment[]>("/api/automation-environments");
export const saveAutomationEnvironment = (e: { id?: string; name: string; variables?: EnvVar[] }) =>
  postJson<AutomationEnvironment>("/api/automation-environments", e);
export const deleteAutomationEnvironment = async (id: string): Promise<void> => {
  const res = await fetch(`/api/automation-environments/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
};

// ── Live step-through executor (run one action at a time in a headed browser) ──
export const stepStart = (payload: { id?: string; automation?: Automation; speed?: RunSpeed }) =>
  postJson<StepRunnerStatus>("/api/automations/step/start", payload);
export const stepNext = () => postJson<StepRunnerStatus>("/api/automations/step/next", {});
export const stepPlay = () => postJson<StepRunnerStatus>("/api/automations/step/play", {});
export const stepPause = () => postJson<StepRunnerStatus>("/api/automations/step/pause", {});
export const stepRestart = () => postJson<StepRunnerStatus>("/api/automations/step/restart", {});
export const stepStop = () => postJson<StepRunnerStatus>("/api/automations/step/stop", {});

// ── Custom scripts (registered in-process or discovered ~/.rubato/scripts) ───
export type { ScriptInfo, ScriptParam } from "@shared/pipeline";
export const fetchScripts = () => getJson<ScriptInfo[]>("/api/scripts");
export const runScript = (payload: { id: string; params?: ScriptParamValues; variables?: Record<string, string> }) =>
  postJson<{ accepted: true; script: string }>("/api/scripts/run", payload);

// ── Pipelines (chain automations + scripts; share a vars bag + run dir) ──────
export type { Pipeline, PipelineRunRecord, PipelineStage, PipelineStageKind, PipelineStageResult } from "@shared/pipeline";
export const fetchPipelines = () => getJson<Pipeline[]>("/api/pipelines");
export const fetchPipeline = (id: string) => getJson<Pipeline>(`/api/pipelines/${encodeURIComponent(id)}`);
export const savePipeline = (p: Partial<Pipeline> & { name: string; stages: Pipeline["stages"] }) =>
  postJson<Pipeline>("/api/pipelines", p);
export async function deletePipeline(id: string): Promise<void> {
  const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}
export const runPipeline = (payload: { id?: string; pipeline?: Pipeline; variables?: Record<string, string> }) =>
  postJson<{ accepted: true; pipeline: string }>("/api/pipelines/run", payload);
export const fetchPipelineRuns = (pipeline?: string) =>
  getJson<PipelineRunRecord[]>(`/api/pipeline-runs${pipeline ? `?pipeline=${encodeURIComponent(pipeline)}` : ""}`);
export const fetchPipelineVariables = (id: string) =>
  getJson<{ variables: PipelineVariable[] }>(`/api/pipelines/${encodeURIComponent(id)}/variables`).then(
    (r) => r.variables,
  );

// ── Excel automations (the unified workbook engine; referenced by `excel` stages) ─
export const fetchExcelProjects = () => getJson<ExcelProject[]>("/api/excel-automations");

// Build-session controls (the headed browser you author against).
export const sessionLaunch = (url: string, headless = false, browser?: BrowserChoice) =>
  postJson<{ ok: true }>("/api/session/launch", { url, headless, browser });
/** Detect which browsers are available on this machine. */
export const sessionBrowsers = () =>
  getJson<{ browsers: DetectedBrowser[] }>("/api/session/browsers").then((r) => r.browsers);
export const sessionGoto = (url: string) => postJson<{ ok: true }>("/api/session/goto", { url });
export const sessionTestSelector = (target: Target) =>
  postJson<{ matchCount: number; visible: boolean }>("/api/session/test-selector", { target });
export const sessionHighlight = (target: Target) => postJson<{ ok: true }>("/api/session/highlight", { target });
export const sessionPicker = (on: boolean) => postJson<{ ok: true }>("/api/session/picker", { on });
export const sessionRecorder = (on: boolean) => postJson<{ ok: true }>("/api/session/recorder", { on });
export const sessionStop = () => postJson<{ ok: true }>("/api/session/stop", {});
/** Toggle artifact capture (HTML + screenshot per moment) on/off; returns live status. */
export const sessionCapture = (on: boolean) => postJson<SessionStatus>("/api/session/capture", { on });
/** Bundle the current screen on demand while capturing ("snapshot now"). */
export const sessionSnapshot = () => postJson<SessionStatus>("/api/session/snapshot", {});
/** Live build/capture session status, for the builder to hydrate its toolbar on mount. */
export const sessionStatus = () => getJson<SessionStatus>("/api/session/status");
export type { SessionStatus } from "@shared/automation";

// ── Ask about your repo (local RAG chat) ─────────────────────────────────────

// Pass the param whenever app is a string (incl. "" for general chat); omit only
// when undefined, which lists conversations across all apps.
export const fetchConversations = (app?: string) =>
  getJson<Conversation[]>(`/api/conversations${app !== undefined ? `?app=${encodeURIComponent(app)}` : ""}`);

export const fetchConversation = (id: string) => getJson<ConversationDetail>(`/api/conversations/${id}`);

export const fetchIndexStatus = (app: string) =>
  getJson<IndexStatus>(`/api/index/${encodeURIComponent(app)}/status`);

export const startIndex = (app: string) => postJson<IndexStatus>(`/api/index/${encodeURIComponent(app)}`, {});

// app "" → a general (no-repo) question. attachments are sent as ad-hoc context;
// fsRoot (general mode only) points the AI at a folder it can read with fs tools.
export const ask = (
  app: string,
  question: string,
  conversationId?: string,
  attachments?: AskAttachment[],
  fsRoot?: string,
  images?: string[],
) => postJson<AskAccepted>("/api/ask", { app: app || undefined, question, conversationId, attachments, fsRoot, images });

// ── Local art generation ─────────────────────────────────────────────────────
export type ArtPreset = "web_ui" | "game_art_2d" | "abstract_texture" | "app_icon" | "raw_creative";

export interface GeneratedAsset {
  fileName: string;
  url: string;
}

export interface GenerateArtResult {
  success: true;
  url: string;
  path: string;
  fileName: string;
  appId: string;
  enrichedPrompt: string;
}

export const generateArt = (input: {
  appId?: string;
  prompt: string;
  preset: ArtPreset;
  width?: number;
  height?: number;
}) => postJson<GenerateArtResult>("/api/generate-image", input);

export const listGeneratedAssets = (appId: string) =>
  getJson<{ files: GeneratedAsset[] }>(`/api/generated-assets/${encodeURIComponent(appId)}`);

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

// ── Splunk query builder ─────────────────────────────────────────────────────

export const fetchSplunkApps = () => getJson<SplunkAppInfo[]>("/api/splunk/apps");

export const fetchSplunkStatus = () => getJson<SplunkStatus>("/api/splunk/status");

export const buildSplunkQuery = (req: SplunkQueryRequest) =>
  postJson<SplunkQueryResponse>("/api/splunk/query", req);

export const runSplunkSearch = (req: SplunkRunRequest) => postJson<SplunkRunResponse>("/api/splunk/run", req);

// ── Service catalog (generic API runner) ─────────────────────────────────────

export const fetchServices = () => getJson<ServiceInfo[]>("/api/services");

export const runService = (req: ServiceRunRequest) => postJson<ServiceRunResponse>("/api/services/run", req);

// ── Saved Tools-tab items (curl requests + regexes + crons) ──────────────────

export const fetchSavedCurlRequests = () => getJson<SavedCurlRequest[]>("/api/tools/curl-requests");
export const saveCurlRequest = (req: SaveCurlRequest) =>
  postJson<SavedCurlRequest>("/api/tools/curl-requests", req);
export async function deleteSavedCurlRequest(id: string): Promise<void> {
  const res = await fetch(`/api/tools/curl-requests/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

export const fetchSavedRegexes = () => getJson<SavedRegex[]>("/api/tools/regexes");
export const saveRegex = (req: SaveRegex) => postJson<SavedRegex>("/api/tools/regexes", req);
export async function deleteSavedRegex(id: string): Promise<void> {
  const res = await fetch(`/api/tools/regexes/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

export const fetchSavedCrons = () => getJson<SavedCron[]>("/api/tools/crons");
export const saveCron = (req: SaveCron) => postJson<SavedCron>("/api/tools/crons", req);
export async function deleteSavedCron(id: string): Promise<void> {
  const res = await fetch(`/api/tools/crons/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

// ── Request builder (HTTP requests + environments) ───────────────────────────

export type { Environment, HttpRequest, HttpResult, KV, SavedRequest } from "@shared/request/model";

export const fetchRequests = () => getJson<SavedRequest[]>("/api/requests");
export const saveHttpRequest = (r: { id?: string; name: string; folder?: string; request: HttpRequest }) =>
  postJson<SavedRequest>("/api/requests", r);
export async function deleteHttpRequest(id: string): Promise<void> {
  const res = await fetch(`/api/requests/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}
export const runHttpRequest = (request: HttpRequest, variables?: Record<string, string>) =>
  postJson<HttpResult>("/api/requests/run", { request, variables });

export const fetchEnvironments = () => getJson<Environment[]>("/api/environments");
export const saveEnvironment = (e: { id?: string; name: string; variables: KV[] }) =>
  postJson<Environment>("/api/environments", e);
export async function deleteEnvironment(id: string): Promise<void> {
  const res = await fetch(`/api/environments/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

import type {
  DbConnectionInput as QBDbConnectionInput,
  DbConnectionWithStatus as QBDbConnectionWithStatus,
  MongoRunBody as QBMongoRunBody,
  RunQueryResult as QBRunQueryResult,
  SavedDbQuery as QBSavedDbQuery,
  SavedDbQueryInput as QBSavedDbQueryInput,
  SqlRunBody as QBSqlRunBody,
} from "@shared/queryBuilder";

// ── Query builder (DB connections + saved queries + gated execution) ─────────

export type {
  DbConnection,
  DbConnectionInput,
  DbConnectionWithStatus,
  MongoRunBody,
  QueryDialect,
  RunQueryResult,
  SavedDbQuery,
  SavedDbQueryInput,
  SqlRunBody,
} from "@shared/queryBuilder";
export { QUERY_DIALECTS } from "@shared/queryBuilder";

export const fetchDbConnections = () => getJson<QBDbConnectionWithStatus[]>("/api/db-connections");
export const saveDbConnection = (input: QBDbConnectionInput & { id?: string }) =>
  postJson<QBDbConnectionWithStatus>("/api/db-connections", input);
export async function deleteDbConnection(id: string): Promise<void> {
  const res = await fetch(`/api/db-connections/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

/** Run a query. Failures (bad SQL, no credentials, missing driver) come back as ok:false, not throws. */
export async function runDbQuery(id: string, body: QBSqlRunBody | QBMongoRunBody): Promise<QBRunQueryResult> {
  const res = await fetch(`/api/db-connections/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as QBRunQueryResult | { error?: string } | null;
  if (data && typeof data === "object" && "ok" in data) return data;
  return {
    ok: false,
    error: { code: `${res.status}`, message: errMessage(data) ?? `${res.status}` },
  };
}

export const fetchSavedDbQueries = () => getJson<QBSavedDbQuery[]>("/api/db-queries");
export const saveSavedDbQuery = (input: QBSavedDbQueryInput & { id?: string }) =>
  postJson<QBSavedDbQuery>("/api/db-queries", input);
export async function deleteSavedDbQuery(id: string): Promise<void> {
  const res = await fetch(`/api/db-queries/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

// ── ServiceNow (connections + saved requests + gated execution) ──────────────

import type {
  SnConnectionInput,
  SnConnectionWithStatus,
  SnRunBody,
  SnRunResult,
  SnSavedRequest,
  SnSavedRequestInput,
} from "@shared/servicenow";

export type {
  SnConnection,
  SnConnectionInput,
  SnConnectionWithStatus,
  SnHttpMethod,
  SnOperation,
  SnRequestSpec,
  SnRunBody,
  SnRunResult,
  SnSavedRequest,
  SnSavedRequestInput,
} from "@shared/servicenow";
export { SN_OPERATIONS } from "@shared/servicenow";

export const fetchSnConnections = () => getJson<SnConnectionWithStatus[]>("/api/servicenow-connections");
export const saveSnConnection = (input: SnConnectionInput & { id?: string }) =>
  postJson<SnConnectionWithStatus>("/api/servicenow-connections", input);
export async function deleteSnConnection(id: string): Promise<void> {
  const res = await fetch(`/api/servicenow-connections/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

/** Run a ServiceNow request. Failures (no creds, blocked write, bad shape) come back as ok:false, not throws. */
export async function runSnRequest(id: string, body: SnRunBody): Promise<SnRunResult> {
  const res = await fetch(`/api/servicenow-connections/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as SnRunResult | { error?: string } | null;
  if (data && typeof data === "object" && "ok" in data) return data as SnRunResult;
  return {
    ok: false,
    error: { code: `${res.status}`, message: errMessage(data) ?? `${res.status}` },
  };
}

export const fetchSnRequests = () => getJson<SnSavedRequest[]>("/api/servicenow-requests");
export const saveSnRequest = (input: SnSavedRequestInput & { id?: string }) =>
  postJson<SnSavedRequest>("/api/servicenow-requests", input);
export async function deleteSnRequest(id: string): Promise<void> {
  const res = await fetch(`/api/servicenow-requests/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

// ── Board (kanban work tasks) ─────────────────────────────────────────────────

import type { BoardTask as BBoardTask, BoardTaskInput as BBoardTaskInput } from "@shared/board";

export type { BoardStatus, BoardTask, BoardTaskInput } from "@shared/board";
export { BOARD_STATUS_LABELS, BOARD_STATUSES } from "@shared/board";

export const fetchBoardTasks = () => getJson<BBoardTask[]>("/api/board");
export const saveBoardTask = (input: BBoardTaskInput & { id?: string }) => postJson<BBoardTask>("/api/board", input);
export async function deleteBoardTask(id: string): Promise<void> {
  const res = await fetch(`/api/board/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}
export async function uploadBoardImage(file: File): Promise<string> {
  const form = new FormData();
  form.set("file", file);
  const res = await fetch("/api/board/upload", { method: "POST", body: form });
  const data = (await res.json()) as { url?: string; error?: string };
  if (!res.ok || !data.url) throw new Error(errMessage(data) ?? `upload failed → ${res.status}`);
  return data.url;
}

// ── Links (bookmark / link manager) ──────────────────────────────────────────

import type { LinkImportResult, LinkItem as BLinkItem, LinkItemInput as BLinkItemInput } from "@shared/links";

export type { LinkImportResult, LinkItem, LinkItemInput } from "@shared/links";

export const fetchLinks = () => getJson<BLinkItem[]>("/api/links");
export const saveLink = (input: BLinkItemInput & { id?: string }) => postJson<BLinkItem>("/api/links", input);
export async function deleteLink(id: string): Promise<void> {
  const res = await fetch(`/api/links/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}
export const importBookmarks = (html: string) => postJson<LinkImportResult>("/api/links/import", { html });

// ── Task Draft Forge (Ollama-enhanced task drafts → taskq) ───────────────────

import type {
  DraftDetail,
  EnhancedTask,
  EnhanceRequest,
  ForgeDraft,
  ForgeDraftInput,
  ForgeDraftPatch,
  ForgePrompt,
  ForgePromptInput,
} from "@shared/forge";

export type {
  DraftDetail,
  EnhancedTask,
  ForgeDraft,
  ForgeDraftInput,
  ForgeDraftPatch,
  ForgePrompt,
  ForgePromptInput,
  ForgeTargetStatus,
} from "@shared/forge";
export { FORGE_TARGET_STATUSES } from "@shared/forge";

export const fetchDrafts = () => getJson<ForgeDraft[]>("/api/forge/drafts");
export const fetchDraftDetail = (id: number) => getJson<DraftDetail>(`/api/forge/drafts/${id}`);
export const createDraft = (input: ForgeDraftInput) => postJson<ForgeDraft>("/api/forge/drafts", input);
export const updateDraft = (id: number, patch: ForgeDraftPatch) =>
  patchJson<ForgeDraft>(`/api/forge/drafts/${id}`, patch);
export const deleteDraft = (id: number) => sendJson<{ deleted: boolean }>("DELETE", `/api/forge/drafts/${id}`, {});
export const enhanceDraft = (id: number, req: EnhanceRequest) =>
  postJson<ForgeDraft>(`/api/forge/drafts/${id}/enhance`, req);
export const publishDraft = (id: number) => postJson<ForgeDraft>(`/api/forge/drafts/${id}/publish`, {});
export const updateRevision = (id: number, ai_specification: string) =>
  patchJson<EnhancedTask>(`/api/forge/revisions/${id}`, { ai_specification });

export const fetchForgePrompts = () => getJson<ForgePrompt[]>("/api/forge/prompts");
export const createForgePrompt = (input: ForgePromptInput) => postJson<ForgePrompt>("/api/forge/prompts", input);
export const updateForgePrompt = (id: number, input: ForgePromptInput) =>
  patchJson<ForgePrompt>(`/api/forge/prompts/${id}`, input);
export const deleteForgePrompt = (id: number) =>
  sendJson<{ deleted: boolean }>("DELETE", `/api/forge/prompts/${id}`, {});

// ── Ollama daemon control (Orchestration "Ollama" tab) ───────────────────────

import type { OllamaModel, OllamaRunningModel, OllamaStatus } from "@shared/ollama";

export type { OllamaModel, OllamaRunningModel, OllamaStatus } from "@shared/ollama";

export const fetchOllamaStatus = () => getJson<OllamaStatus>("/api/ollama/status");
export const fetchOllamaModels = () => getJson<OllamaModel[]>("/api/ollama/models");
export const fetchOllamaRunning = () => getJson<OllamaRunningModel[]>("/api/ollama/running");
export const pullOllamaModel = (model: string) => postJson<{ status: string }>("/api/ollama/pull", { model });
export const setOllamaModel = (model: string) => postJson<OllamaStatus>("/api/ollama/model", { model });
export const stopOllamaModel = (model: string) => postJson<{ ok: boolean }>("/api/ollama/stop", { model });
export const startOllamaDaemon = () => postJson<OllamaStatus>("/api/ollama/serve", {});
export const deleteOllamaModel = (name: string) =>
  sendJson<{ deleted: boolean }>("DELETE", `/api/ollama/models/${encodeURIComponent(name)}`, {});

// ── Vault (encrypted, master-password-gated credential store) ─────────────────

import type { VaultItem as BVaultItem, VaultItemInput as BVaultItemInput, VaultStatus } from "@shared/vault";

export type { VaultField, VaultItem, VaultItemInput, VaultStatus } from "@shared/vault";

export const fetchVaultStatus = () => getJson<VaultStatus>("/api/vault/status");

// Master-password lifecycle. Each returns the in-memory unlock token on success.
export const setVaultMaster = (masterPassword: string) =>
  postJson<{ token: string }>("/api/vault/master", { masterPassword });
export const unlockVault = (masterPassword: string) => postJson<{ token: string }>("/api/vault/unlock", { masterPassword });
export const changeVaultMaster = (currentPassword: string, newPassword: string) =>
  postJson<{ token: string }>("/api/vault/master/change", { currentPassword, newPassword });

// Item reads/writes carry the unlock token in the `x-vault-token` header (the
// token is never persisted — it lives only in the page's memory).
async function vaultRequest<T>(method: string, url: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-vault-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as T & { error?: unknown };
  if (!res.ok) throw apiError(res, data);
  return data;
}

export const fetchVaultItems = (token: string) => vaultRequest<BVaultItem[]>("GET", "/api/vault/items", token);
export const createVaultItem = (token: string, input: BVaultItemInput) =>
  vaultRequest<BVaultItem>("POST", "/api/vault/items", token, input);
export const updateVaultItem = (token: string, id: string, input: BVaultItemInput) =>
  vaultRequest<BVaultItem>("PATCH", `/api/vault/items/${encodeURIComponent(id)}`, token, input);
export async function deleteVaultItem(id: string): Promise<void> {
  const res = await fetch(`/api/vault/items/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

// ── Custom Pages (user-built dashboards) ──────────────────────────────────────

import type { CustomPage as BCustomPage, CustomPageInput as BCustomPageInput } from "@shared/customPage";

export type { CustomPage, CustomPageInput } from "@shared/customPage";

export const fetchCustomPages = () => getJson<BCustomPage[]>("/api/pages");
export const saveCustomPage = (input: BCustomPageInput & { id?: string }) =>
  postJson<BCustomPage>("/api/pages", input);
export async function deleteCustomPage(id: string): Promise<void> {
  const res = await fetch(`/api/pages/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

// ── Dashboard (per-app status aggregation) ───────────────────────────────────

import type {
  DashboardData as DD,
  TagAppResult as TAR,
  TagAppsRequest as TARq,
  TagSearchResponse as TSR,
} from "@shared/dashboard";

export type {
  DashboardAppRow,
  DashboardData,
  DashboardDeploy,
  DashboardGit,
  DashboardTag,
  TagAppResult,
  TagSearchAppResult,
  TagSearchResponse,
} from "@shared/dashboard";

/** The board's git facts; pass includeDeploy to also resolve deployed versions
 *  (optionally scoped to an environment, e.g. "stage"). */
export const fetchDashboard = (includeDeploy = false, env?: string) => {
  if (!includeDeploy) return getJson<DD>("/api/dashboard");
  const qs = env ? `?deploy=1&env=${encodeURIComponent(env)}` : "?deploy=1";
  return getJson<DD>(`/api/dashboard${qs}`);
};
export const tagApps = (body: TARq) => postJson<{ results: TAR[] }>("/api/dashboard/tag", body);

// Search tags across apps (optionally a name prefix, app subset, and limit).
export const searchDashboardTags = (opts: { prefix?: string; apps?: string[]; limit?: number } = {}) => {
  const p = new URLSearchParams();
  if (opts.prefix) p.set("prefix", opts.prefix);
  if (opts.apps?.length) p.set("apps", opts.apps.join(","));
  if (opts.limit) p.set("limit", String(opts.limit));
  const qs = p.toString();
  return getJson<TSR>(`/api/dashboard/tags${qs ? `?${qs}` : ""}`);
};

// ── Session/JWT (auth) ───────────────────────────────────────────────────────
export type { AuthConfigState, FetchSessionRequest, SaveAuthVarRequest, SessionTokenResult } from "@shared/auth";

export const fetchAuthConfig = () => getJson<import("@shared/auth").AuthConfigState>("/api/auth/config");
export const fetchSessionToken = (body: import("@shared/auth").FetchSessionRequest = {}) =>
  postJson<import("@shared/auth").SessionTokenResult>("/api/auth/session", body);
export const saveAuthVar = (name: string, value: string) =>
  postJson<{ ok: boolean; name: string }>("/api/auth/save-var", { name, value });

// ── Vulnerabilities (AppScan/ASoC scan stats) ───────────────────────────────
export type {
  DeployApp,
  DeployPipeline,
  VulnerabilitiesResponse,
  VulnerabilityInput,
  VulnerabilityRecord,
  VulnSeverity,
  VulnStats,
} from "@shared/vulnerabilities";
export { DEPLOY_PIPELINES, VULN_SEVERITIES } from "@shared/vulnerabilities";

export const fetchVulnerabilities = () =>
  getJson<import("@shared/vulnerabilities").VulnerabilitiesResponse>("/api/vulnerabilities");
export const addVulnerability = (input: import("@shared/vulnerabilities").VulnerabilityInput) =>
  postJson<import("@shared/vulnerabilities").VulnerabilitiesResponse>("/api/vulnerabilities", input);
export async function clearVulnerabilities(): Promise<import("@shared/vulnerabilities").VulnerabilitiesResponse> {
  const res = await fetch("/api/vulnerabilities", { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /api/vulnerabilities → ${res.status}`);
  return res.json();
}
export async function deleteVulnerability(
  app: string,
  scanType = "",
): Promise<import("@shared/vulnerabilities").VulnerabilitiesResponse> {
  const qs = scanType ? `?scanType=${encodeURIComponent(scanType)}` : "";
  const res = await fetch(`/api/vulnerabilities/${encodeURIComponent(app)}${qs}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /api/vulnerabilities/${app} → ${res.status}`);
  return res.json();
}

/** The parse result echoed back from an import, alongside the refreshed snapshot. */
export type VulnImportResponse = import("@shared/vulnerabilities").VulnerabilitiesResponse & {
  imported?: { app: string; scanType: string; isAppScan: boolean; report: unknown };
};

/** Upload an AppScan/ASoC report PDF; the server parses + stores it. */
export async function importVulnerabilityPdf(
  file: File,
  opts: { app?: string; scanType?: string; linkedApp?: string } = {},
): Promise<VulnImportResponse> {
  const form = new FormData();
  form.append("file", file);
  if (opts.app) form.append("app", opts.app);
  if (opts.scanType) form.append("scanType", opts.scanType);
  if (opts.linkedApp) form.append("linkedApp", opts.linkedApp);
  const res = await fetch("/api/vulnerabilities/import-pdf", { method: "POST", body: form });
  if (!res.ok) throw apiError(res, await res.json().catch(() => null));
  return res.json();
}

/** Registry apps that deploy via Jenkins/Harness — the scan-association candidates. */
export const fetchDeployApps = () =>
  getJson<import("@shared/vulnerabilities").DeployApp[]>("/api/vulnerabilities/deploy-apps");

/**
 * Associate a scan with a deployed app (or clear it with `null`). Returns the
 * refreshed snapshot plus the updated record.
 */
export const linkVulnerabilityApp = (
  app: string,
  scanType: string,
  linkedApp: string | null,
): Promise<import("@shared/vulnerabilities").VulnerabilitiesResponse> => {
  const qs = scanType ? `?scanType=${encodeURIComponent(scanType)}` : "";
  return postJson<import("@shared/vulnerabilities").VulnerabilitiesResponse>(
    `/api/vulnerabilities/${encodeURIComponent(app)}/link${qs}`,
    { linkedApp },
  );
};

/** Inline URL for a stored report PDF (opens in the browser's PDF viewer). */
export const vulnerabilityReportUrl = (app: string, scanType = ""): string =>
  `/api/vulnerabilities/${encodeURIComponent(app)}/report${scanType ? `?scanType=${encodeURIComponent(scanType)}` : ""}`;

/** Ask the configured LLM for a remediation plan for one record; returns the new plan id. */
export async function generateVulnerabilityPlan(
  app: string,
  scanType = "",
): Promise<{ planId: string; title: string }> {
  const qs = scanType ? `?scanType=${encodeURIComponent(scanType)}` : "";
  const res = await fetch(`/api/vulnerabilities/${encodeURIComponent(app)}/plan${qs}`, { method: "POST" });
  if (!res.ok) throw apiError(res, await res.json().catch(() => null));
  return res.json();
}

// ── Plans (AI remediation plans — view/edit/export) ──────────────────────────

import type { Plan, PlanInput } from "@shared/plans";

export type { Plan, PlanInput } from "@shared/plans";

export const fetchPlans = () => getJson<Plan[]>("/api/plans");
export const savePlan = (input: PlanInput & { id?: string }) => postJson<Plan>("/api/plans", input);
export async function deletePlan(id: string): Promise<void> {
  const res = await fetch(`/api/plans/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

// ── Orchestration (unattended task-queue workflow dashboard) ─────────────────

import type {
  ApplyFleetPresetResult,
  ConfigPatchResult,
  DrainConfigPatch,
  FleetPreset,
  LogTail,
  OrchestrationFileDoc,
  OrchestrationFileInfo,
  OrchestrationOverview,
  ReconcileFleetResult,
  RestartResult,
  SaveFleetPreset,
  TaskDraft,
  TaskInsertPosition,
  WatchdogAgentResult,
  WatchdogSnapshot,
  WorkflowBoard,
} from "@shared/orchestration";

export type {
  ActiveRun,
  ApplyFleetPresetResult,
  ConfigPatchResult,
  DrainConfig,
  DrainConfigPatch,
  DrainModelOption,
  DrainSettingClass,
  FileLocation,
  FleetPreset,
  FleetSlot,
  FleetTier,
  ProblemFix,
  ReadyTask,
  ReconcileFleetResult,
  SaveFleetPreset,
  UnservableSummary,
  WorkerSlotStatus,
  HistoryEntry,
  LaunchdInfo,
  LogFileInfo,
  LogTail,
  NeedsRestartField,
  OrchestrationFileDoc,
  OrchestrationFileInfo,
  OrchestrationOverview,
  OrchestrationStats,
  PendingChange,
  Problem,
  RestartResult,
  RunEntry,
  RunStatus,
  TaskDraft,
  TaskDraftStatus,
  TaskInsertPosition,
  ThinkingLevel,
  WatchdogAgentResult,
  WatchdogCommand,
  WatchdogSnapshot,
  WatchdogStatusLine,
  WatchdogTick,
  WorkerInstance,
  WorkerProcess,
  WorkflowBoard,
  WorkflowTask,
  WorkflowTaskStatus,
} from "@shared/orchestration";
export {
  DEFAULT_DRAIN_MODEL,
  DRAIN_MODEL_IDS,
  DRAIN_MODEL_OPTIONS,
  DRAIN_SETTING_CLASS,
  deriveTaskTitle,
  draftFromTask,
  effectiveTaskTitle,
  FLEET_MODEL_OPTIONS,
  isTaskEditable,
  NEEDS_RESTART_FIELDS,
  serializeTaskBlock,
  TASK_DRAFT_STATUS_LABELS,
  TASK_DRAFT_STATUSES,
  TASK_ID_PATTERN,
  TASK_MODEL_ALIASES,
  THINKING_LEVELS,
  thinkingTokensFor,
  validateTaskDraft,
} from "@shared/orchestration";

/** The whole-page snapshot (board + history + runs + stats). */
export const fetchOrchestration = () => getJson<OrchestrationOverview>("/api/orchestration");
/** The editable config/doc/board files (allowlist — no content). */
export const fetchOrchestrationFiles = () => getJson<OrchestrationFileInfo[]>("/api/orchestration/files");
/** One file's content (the editor's load). */
export const fetchOrchestrationFile = (key: string) =>
  getJson<OrchestrationFileDoc>(`/api/orchestration/files/${encodeURIComponent(key)}`);
/** Save one file's content (creates it if absent). */
export const saveOrchestrationFile = (key: string, content: string) =>
  postJson<OrchestrationFileDoc>(`/api/orchestration/files/${encodeURIComponent(key)}`, { content });

// ── Task builder (compose/edit/delete a TASKS.md entry, race-safe) ────────────

/** Create a task from a draft, inserted at the given position; returns the new board. */
export const createOrchestrationTask = (draft: TaskDraft, position: TaskInsertPosition) =>
  postJson<{ board: WorkflowBoard }>("/api/orchestration/tasks", { draft, position });
/** Replace the task matched by its verbatim heading with a new draft. */
export const updateOrchestrationTask = (anchorHeading: string, draft: TaskDraft) =>
  patchJson<{ board: WorkflowBoard }>("/api/orchestration/tasks", { anchorHeading, draft });
/** Delete the task matched by its verbatim heading; returns the new board. */
export const deleteOrchestrationTask = (anchorHeading: string) =>
  sendJson<{ board: WorkflowBoard }>("DELETE", "/api/orchestration/tasks", { anchorHeading });

// ── Taskq (v2 orchestrator — SQLite-backed board CRUD) ───────────────────────
export type {
  BucketState as TaskqBucketState,
  CcusageDailyEntry as TaskqCcusageDaily,
  CcusageReport as TaskqCcusageReport,
  OpenClarification as TaskqClarification,
  ComprehensiveClaudeReport as TaskqClaudeTelemetry,
  NewTask as TaskqNewTask,
  Position as TaskqPosition,
  TaskPatch as TaskqPatch,
  TaskqBoard,
  TaskqTaskView,
  TaskqUsageSnapshot,
  TaskRow as TaskqRow,
  TaskStatus as TaskqStatus,
} from "@shared/taskq";
export {
  TASKQ_AUTHORABLE_STATUSES,
  TASKQ_MODEL_ALIASES,
  TASKQ_STATUS_LABELS,
  TASKQ_STATUSES,
  TASKQ_THINK_LEVELS,
} from "@shared/taskq";
import type {
  BucketState,
  NewTask,
  OpenClarification,
  Position,
  TaskPatch,
  TaskqBoard,
  TaskqUsageSnapshot,
  TaskStatus,
} from "@shared/taskq";

/** The whole board (tasks + per-status counts). */
export const fetchTaskqBoard = () => getJson<TaskqBoard>("/api/taskq");
/** Create a task at a position (default top); returns the new board + id. */
export const createTaskqTask = (draft: NewTask, position?: Position) =>
  postJson<{ board: TaskqBoard; id: number }>("/api/taskq/tasks", { draft, position });
/** Patch a task by id. */
export const updateTaskqTask = (id: number, patch: TaskPatch) =>
  patchJson<{ board: TaskqBoard }>(`/api/taskq/tasks/${id}`, { patch });
/** Delete a task by id. */
export const deleteTaskqTask = (id: number) =>
  sendJson<{ board: TaskqBoard }>("DELETE", `/api/taskq/tasks/${id}`, {});
/** Set a task's status (+ optional note). */
export const setTaskqStatus = (id: number, status: TaskStatus, note?: string) =>
  postJson<{ board: TaskqBoard }>(`/api/taskq/tasks/${id}/status`, { status, note });
/** Re-position a task. */
export const moveTaskqTask = (id: number, position: Position) =>
  postJson<{ board: TaskqBoard }>(`/api/taskq/tasks/${id}/move`, { position });
/** Enqueue a copy of a template task as a ready one-shot. */
export const enqueueTaskqTemplate = (id: number) =>
  postJson<{ board: TaskqBoard; id: number }>(`/api/taskq/tasks/${id}/enqueue`, {});
/** Current token-usage bucket capacities. */
export const fetchTaskqUsage = () => getJson<{ buckets: BucketState[] }>("/api/taskq/usage");
/** Live real-usage snapshot: `/usage` telemetry + ccusage cost, each with status. */
export const fetchTaskqUsageLive = () => getJson<TaskqUsageSnapshot>("/api/taskq/usage/live");
/** Re-poll both live-usage sources now and return the fresh snapshot. */
export const refreshTaskqUsage = () => postJson<TaskqUsageSnapshot>("/api/taskq/usage/refresh", {});
/** Manually calibrate a usage bucket from a /usage reading. */
export const calibrateTaskqBucket = (input: {
  key: string;
  consumedFraction: number;
  limitUnits?: number;
  resetAt?: number;
}) => postJson<{ buckets: BucketState[] }>("/api/taskq/usage/calibrate", input);
/**
 * Self-heal the usage estimate: fire a real probe to learn whether we're actually
 * out of tokens, then auto-recalibrate. No manual numbers — used by the
 * "I'm not actually out — re-check" button.
 */
export const probeTaskqCapacity = () =>
  postJson<{
    probe: { rateLimited: boolean; ok: boolean; detail: string };
    reconciled: { key: string; reason: string; limitUnits: number }[];
    buckets: BucketState[];
  }>("/api/taskq/usage/probe", {});
/** Open clarification gateways (the Input Queue). */
export const fetchTaskqClarifications = () =>
  getJson<{ clarifications: OpenClarification[] }>("/api/taskq/clarifications");
/** Answer a gateway — releases the epic's child tasks. */
export const answerTaskqClarification = (taskId: number, answer: string) =>
  postJson<{ board: TaskqBoard; clarifications: OpenClarification[] }>(
    `/api/taskq/clarifications/${taskId}/answer`,
    { answer },
  );

export interface TaskqDrainerStatus {
  watchdogLoaded: boolean;
  running: boolean;
  stopped: boolean;
  /** Unix ms when the drain last started (from .last-fire stamp). */
  lastFireMs?: number;
}
export interface TaskqCompletion {
  task_id: number;
  title: string;
  repo: string | null;
  commit: string | null;
  started_at: number | null;
  ended_at: number;
  duration_s: number | null;
  summary: string | null;
  model: string | null;
  think: string | null;
  fast: number;
  body: string | null;
}
export interface TaskqHistoryResult {
  recent: TaskqCompletion[];
  stats: { total: number; totalDurationS: number };
}

/** Recent completed tasks + aggregates. */
export const fetchTaskqHistory = () => getJson<TaskqHistoryResult>("/api/taskq/history");
/** Drainer status (watchdog loaded? running? stop-sentinel set?). */
export const fetchTaskqDrainer = () => getJson<TaskqDrainerStatus>("/api/taskq/drainer");
/** Spawn a drain pass now. */
export const runTaskqDrainer = () => postJson<{ ok: boolean; status: TaskqDrainerStatus }>("/api/taskq/drainer/run", {});
/** Set the graceful-stop sentinel. */
export const stopTaskqDrainer = () => postJson<{ ok: boolean; status: TaskqDrainerStatus }>("/api/taskq/drainer/stop", {});
/** Clear the stop sentinel. */
export const resumeTaskqDrainer = () =>
  postJson<{ ok: boolean; status: TaskqDrainerStatus }>("/api/taskq/drainer/resume", {});

export interface TaskqFleetTier {
  models: string[];
  jobs: number;
}
export interface TaskqConfig {
  jobs: number;
  model: string;
  think?: string;
  fast?: boolean;
  fleet?: TaskqFleetTier[];
  leaseTtlMs: number;
  triage?: { enabled: boolean };
  repos: Record<string, string>;
  /** Background `/usage` telemetry poll interval, minutes (0 = off, manual only). */
  usagePollMinutes: number;
  /** Background `ccusage` cost poll interval, minutes (0 = off, manual only). */
  usageCostPollMinutes: number;
}
export interface TaskqConfigPatch {
  jobs?: number;
  model?: string;
  think?: string;
  fast?: boolean;
  fleet?: TaskqFleetTier[] | null;
  leaseTtlMs?: number;
  triageEnabled?: boolean;
  usagePollMinutes?: number;
  usageCostPollMinutes?: number;
}
export interface TaskqInstance {
  task_id: number;
  title: string;
  repo: string | null;
  model: string | null;
  think: string | null;
  fast: number;
  slug: string | null;
  group_key: string | null;
  worker_id: string;
  worktree: string | null;
  claimed_at: number;
  heartbeat_at: number;
  expires_at: number;
}

/** View the effective config + the watchdog tick interval. */
export const fetchTaskqConfig = () => getJson<{ config: TaskqConfig; interval: number }>("/api/taskq/config");
/** Patch the editable config knobs (jobs/model/think/fast/fleet/leaseTtl/triage). */
export const saveTaskqConfig = (patch: TaskqConfigPatch) =>
  postJson<{ config: TaskqConfig; interval: number }>("/api/taskq/config", patch);
/** Live worker instances (current leases). */
export const fetchTaskqInstances = () => getJson<{ instances: TaskqInstance[] }>("/api/taskq/instances");
/** Release a claimed task back to ready (abandon the lease). */
export const releaseTaskqInstance = (taskId: number) =>
  postJson<{ board: TaskqBoard; instances: TaskqInstance[] }>(`/api/taskq/instances/${taskId}/release`, {});
/** Tail the watchdog log. */
export const fetchTaskqLogs = (lines = 200) => getJson<{ path: string; lines: string[] }>(`/api/taskq/logs?lines=${lines}`);

/** A single drain pass audit record. */
export interface TaskqDrainRun {
  id: number;
  started_at: number;
  ended_at: number | null;
  decision: string; // 'normal' | 'paused' | 'throttled' | 'stopped'
  reason: string;
  jobs: number;
  max_jobs: number;
  completed: number | null;
  failed: number | null;
  reaped: number | null;
}

/** Fetch recent drain run audit records. */
export const fetchTaskqDrainRuns = (limit = 30) =>
  getJson<TaskqDrainRun[]>('/api/taskq/drain-runs?limit=' + limit);
/** Load or unload the launchd watchdog. */
export const setTaskqWatchdog = (action: "load" | "unload") =>
  postJson<{ ok: boolean; out: string; status: TaskqDrainerStatus }>("/api/taskq/drainer/watchdog", { action });
/** Set the watchdog tick interval (seconds). */
export const setTaskqInterval = (seconds: number) =>
  postJson<{ ok: boolean; out: string; interval: number }>("/api/taskq/drainer/interval", { seconds });
/** Get persisted board section collapse state. */
export const fetchTaskqSectionPrefs = () =>
  getJson<{ prefs: Record<string, boolean> }>("/api/taskq/section-prefs");
/** Patch one or more board section collapse states. */
export const setTaskqSectionCollapsed = (patch: Record<string, boolean>) =>
  postJson<{ prefs: Record<string, boolean> }>("/api/taskq/section-prefs", patch);

/** List distinct serial group names currently in the queue. */
export const fetchTaskqSerialGroups = () =>
  getJson<{ groups: string[] }>("/api/taskq/serial-groups");
/** Bulk-assign a serial_group to a set of tasks (null to clear). */
export const bulkSetTaskqSerialGroup = (ids: number[], serial_group: string | null) =>
  postJson<{ board: TaskqBoard }>("/api/taskq/tasks/bulk-serial-group", { ids, serial_group });

export interface TaskqCapacityScheduleDecision {
  paused: boolean;
  recommendedJobs: number;
  preferLight: boolean;
  burnExpiring: boolean;
  reason: string;
}

export interface TaskqCapacityWorkerSlot {
  index: number;
  /** null = flat mode (any task); otherwise the fleet tier's model aliases */
  models: string[] | null;
}

export interface TaskqCapacityReadyTask {
  id: number;
  title: string;
  /** The model marker on the task (null = no pin). */
  model: string | null;
  /** What model the worker will actually pass to claude -p: task.model ?? config.model */
  effectiveModel: string;
  repo: string | null;
  /** Worker slot indices (0-based) that can claim this task. */
  claimableBySlots: number[];
  /** Set when no slot can claim this task. */
  unclaimableReason?: string;
}

export interface TaskqCapacity {
  defaultModel: string;
  configuredJobs: number;
  fleetMode: boolean;
  decision: TaskqCapacityScheduleDecision;
  /** Total worker slots (fleet total or config.jobs). */
  maxJobs: number;
  /** min(maxJobs, decision.recommendedJobs) — workers the next drain will spawn. */
  effectiveJobs: number;
  workerSlots: TaskqCapacityWorkerSlot[];
  totalReady: number;
  /** Ready tasks no slot can claim (model mismatch). */
  unservableReady: number;
  readyTasks: TaskqCapacityReadyTask[];
  buckets: { key: string; fraction: number; remaining: number; resetInSeconds?: number }[];
}

/** Capacity snapshot: schedule decision + ready-task eligibility for the next drain. */
export const fetchTaskqCapacity = () => getJson<TaskqCapacity>("/api/taskq/capacity");

// ── Watchdog control + observe ────────────────────────────────────────────────

/** The live watchdog snapshot (config + status + instances + problems + logs + …). */
export const fetchWatchdog = () => getJson<WatchdogSnapshot>("/api/orchestration/watchdog");
/**
 * Patch drain.config (enabled / autoRestart / jobs / model / thinkingLevel /
 * fastMode / dirs). Returns the new config + the fields that changed + any
 * auto-restart this patch triggered (AUTO_RESTART on + a needs-restart key
 * changed while a drainer is live).
 */
export const patchDrainConfig = (patch: DrainConfigPatch) =>
  postJson<ConfigPatchResult>("/api/orchestration/watchdog/config", patch);
/** Set the watchdog's launchd tick interval (seconds) + reload the agent. */
export const setWatchdogInterval = (seconds: number) =>
  postJson<{ intervalSeconds: number; reloaded: boolean; reloadError?: string }>(
    "/api/orchestration/watchdog/interval",
    { seconds },
  );
/**
 * Start / stop / restart the launchd watchdog AGENT itself (load/unload/reload the
 * plist) — distinct from pausing it (drain.config ENABLED) or the drainer.
 */
export const controlWatchdogAgent = (action: "start" | "stop" | "restart") =>
  postJson<WatchdogAgentResult>("/api/orchestration/watchdog/agent", { action });
/** Start the drainer now (optionally overriding the saved JOBS). */
export const startDrainer = (jobs?: number) =>
  postJson<{ started: boolean; pid?: number; command: string; error?: string }>(
    "/api/orchestration/watchdog/start",
    jobs ? { jobs } : {},
  );
/** Outcome of waking workers — see the server's `wakeWorkers`. */
export interface WakeResult {
  action: "start" | "noop" | "restart";
  jobs: number;
  liveBefore: number;
  wasRunning: boolean;
  started: boolean;
  pid?: number;
  command?: string;
  killed?: number[];
  runnerKilled?: number;
  error?: string;
  message?: string;
}
/** Ensure the drainer runs at the configured JOBS (relaunch it if short-handed). */
export const wakeWorkers = () => postJson<WakeResult>("/api/orchestration/watchdog/wake", {});
/**
 * Restart the drainer so a needs-restart setting takes effect. `graceful`
 * (default) lets the in-flight task finish then relaunches; `force` kills now.
 */
export const restartDrainer = (mode: "graceful" | "force" = "graceful") =>
  postJson<RestartResult>("/api/orchestration/watchdog/restart", { mode });
/** Stop the drainer + its workers (targeted by pid). */
export const stopDrainer = () =>
  postJson<{ stopped: boolean; pid?: number; workerPids: number[]; reason?: string }>(
    "/api/orchestration/watchdog/stop",
    {},
  );
/** Stop one worker by pid (only a known live worker). */
export const stopInstance = (pid: number) =>
  postJson<{ stopped: boolean; pid: number; error?: string }>("/api/orchestration/watchdog/instance/stop", { pid });
/** Tail an allowlisted log file (watchdog logs or a runs-dir file). */
export const fetchLogTail = (key: string, lines = 200) =>
  getJson<LogTail>(`/api/orchestration/logs/${encodeURIComponent(key)}?lines=${lines}`);

// ── Named fleet presets (save / load / swap worker-mix configs) ──────────────

/** The saved named fleet presets ("Strong", "Fast", "Slow", …). */
export const fetchFleetPresets = () => getJson<FleetPreset[]>("/api/orchestration/fleet-presets");
/** Create or overwrite a named fleet preset; returns the updated list. */
export const saveFleetPreset = (input: SaveFleetPreset) =>
  postJson<FleetPreset[]>("/api/orchestration/fleet-presets", input);
/** Delete a named fleet preset by id; returns the remaining list. */
export async function deleteFleetPreset(id: string): Promise<FleetPreset[]> {
  const res = await fetch(`/api/orchestration/fleet-presets/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
  return res.json() as Promise<FleetPreset[]>;
}
/** Apply (swap to) a named fleet preset — writes its tiers into drain.config (auto-restarts when armed). */
export const applyFleetPreset = (id: string) =>
  postJson<ApplyFleetPresetResult>(`/api/orchestration/fleet-presets/${encodeURIComponent(id)}/apply`, {});
/** Grow the fleet to cover unservable tasks — add a tier per needed model, apply + restart. */
export const reconcileFleet = () => postJson<ReconcileFleetResult>("/api/orchestration/fleet/reconcile", {});

// ── Orchestration Processing (per-category timing analytics) ─────────────────

import type {
  CategoryStat as OrchCategoryStat,
  TimingIngestResult,
  TimingOverview,
  TimingQueryParams,
  TimingRow,
  TimingSource,
  TimingSummary,
  TimingTrendPoint,
} from "@shared/orchestration";

export type {
  CategoryStat,
  GroupRollup,
  TimingIngestResult,
  TimingOverview,
  TimingQueryParams,
  TimingRow,
  TimingSource,
  TimingSummary,
  TimingTrendPoint,
} from "@shared/orchestration";
export { bucketTimingTrend } from "@shared/orchestration";

/** Fetch the aggregated timing snapshot for the (optional) date/repo filters. */
export const fetchTimings = (params: TimingQueryParams = {}): Promise<TimingOverview> => {
  const sp = new URLSearchParams();
  if (params.from != null) sp.set("from", String(params.from));
  if (params.to != null) sp.set("to", String(params.to));
  if (params.repo && params.repo !== "all") sp.set("repo", params.repo);
  const qs = sp.toString();
  return getJson<TimingOverview>(`/api/orchestration/timings${qs ? `?${qs}` : ""}`);
};
/** Sync from the timing-*.jsonl files into SQLite (idempotent); returns counts. */
export const ingestTimings = () => postJson<TimingIngestResult>("/api/orchestration/timings/ingest", {});
/** Delete stored timings — all, or only those older than `before` (epoch ms). */
export const clearTimings = (before?: number) =>
  postJson<{ deleted: number }>("/api/orchestration/timings/clear", before != null ? { before } : {});

/** Per-category stats for one history entry, matched by its [start, end] time window. */
export const fetchEntryTimings = (start: string, end: string, repo?: string): Promise<OrchCategoryStat[]> => {
  const sp = new URLSearchParams({ start, end });
  if (repo) sp.set("repo", repo);
  return getJson<OrchCategoryStat[]>(`/api/orchestration/timings/entry?${sp}`);
};

// Re-exported so the page can name them without re-importing from cwip directly.
export type { OrchCategoryStat, TimingRow as OrchTimingRow, TimingSource as OrchTimingSource };
export type { TimingSummary as OrchTimingSummary, TimingTrendPoint as OrchTimingTrendPoint };

// ─── SSH servers (localhost-only Admin panel) ─────────────────────────────────

export interface SshServerSummary {
  index: number;
  label: string;
  command: string;
}

export interface SshOpenResult {
  method: string;
  command: string;
}

/** List configured SSH servers with their prebuilt connection commands. */
export const fetchSshServers = () => getJson<SshServerSummary[]>("/api/servers/ssh");

/** Open an SSH session in a native terminal for the server at `index`. */
export const openSshInTerminal = (index: number) =>
  postJson<SshOpenResult>("/api/servers/ssh/open", { index });

// ── Claude usage / rate-limits ────────────────────────────────────────────────

export type { ClaudeRateLimitInfo } from "@shared/orchestration";
import type { ClaudeRateLimitInfo } from "@shared/orchestration";

/** Probe the Anthropic API (via rubato server) for current rate-limit headers. */
export const fetchClaudeUsage = () => getJson<ClaudeRateLimitInfo>("/api/orchestration/claude-usage");

// ── Shell aliases ─────────────────────────────────────────────────────────────

export interface ShellAlias {
  id: string;
  name: string;
  command: string;
  description: string;
  tags: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShellAliasInput {
  name: string;
  command?: string;
  description?: string;
  tags?: string;
}

export interface ShellConfigInfo {
  file: string;
  label: string;
  path: string;
  exists: boolean;
}

export interface ShellConfigsResult {
  configs: ShellConfigInfo[];
  aliasFile: string;
  aliasFileExists: boolean;
}

export const fetchShellAliases = () => getJson<ShellAlias[]>("/api/shell-aliases");
export const fetchShellConfigs = () => getJson<ShellConfigsResult>("/api/shell-aliases/shell-configs");

export async function createShellAlias(input: ShellAliasInput): Promise<ShellAlias> {
  return postJson<ShellAlias>("/api/shell-aliases", input);
}

export async function updateShellAlias(id: string, patch: Partial<ShellAliasInput>): Promise<ShellAlias> {
  const res = await fetch(`/api/shell-aliases/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update failed → ${res.status}`);
  return res.json();
}

export async function deleteShellAlias(id: string): Promise<void> {
  const res = await fetch(`/api/shell-aliases/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

export const applyShellAliases = (configFile?: string) =>
  postJson<{ applied: number; aliasFile: string }>("/api/shell-aliases/apply", configFile ? { configFile } : {});

export const importShellAliasesFromJson = (aliases: { name: string; command: string; description?: string; tags?: string }[]) =>
  postJson<{ imported: number; skipped: number }>("/api/shell-aliases/import", { aliases });
