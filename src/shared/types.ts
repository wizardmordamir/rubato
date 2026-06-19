/**
 * Wire types shared between the rubato server and the web UI. Pure types only
 * (no runtime imports) so the UI can import them via a Vite alias without
 * pulling in any Bun/Node code.
 */

import type { CurlRequestInput } from './tools/curl';

/**
 * One editable "system file" — an allowlisted, fixed-path file on the user's
 * machine (global `~/.claude/CLAUDE.md`, shell rc files, git config, …) that the
 * Docs hub's System Files page can view + edit. The set is server-defined (see
 * `systemFiles.ts`); the UI never supplies a path, only a `key`, so there is no
 * path-traversal surface. `GET /api/system-files` lists these (sans `content`).
 */
export interface SystemFileInfo {
  /** Stable key the UI passes to read/write this file. */
  key: string;
  /** Human label (e.g. "Global CLAUDE.md", "~/.zshrc"). */
  label: string;
  /** Absolute path of the file (shown in the UI). */
  path: string;
  /** Whether the file currently exists on disk. */
  exists: boolean;
  /** Whether to offer a Markdown preview (true for `.md` files). */
  markdown: boolean;
}

/** A system file plus its current contents ("" when absent). `GET/POST /api/system-files/:key`. */
export interface SystemFileDoc extends SystemFileInfo {
  content: string;
}

/**
 * One admin-only "setup script" — a shell script under `~/.rubato/setup-scripts/`
 * that resets/provisions the machine from scratch (ollama, miniconda, fooocus, the
 * orchestrator, AWS SES/EC2, Cloudflare, rubato + ca). These live OUTSIDE git; the
 * repo ships sanitized templates seeded here, and only the Admin panel surfaces them.
 * `GET /api/admin/setup-scripts` lists these (sans `content`).
 */
export interface SetupScriptInfo {
  /** Bare file name — the key the UI passes to read/write/delete it. */
  name: string;
  /** Human label (from the bundled template, else the file name). */
  label: string;
  /** Absolute path of the file on disk (shown in the UI for local editing). */
  path: string;
  size: number;
  modifiedAt: number;
  /** Whether a bundled default template of this name exists (can be restored). */
  isTemplate: boolean;
  /** One-line description (bundled templates only). */
  description?: string;
}

/** A setup script plus its current contents. `GET/POST /api/admin/setup-scripts/:name`. */
export interface SetupScriptDoc extends SetupScriptInfo {
  content: string;
  exists: boolean;
}

/** A command run recorded by the server (for the activity/notifications feed). */
export interface RunRecord {
  id: number;
  /** Command name (from the registry). */
  command: string;
  /** Args passed to the command. */
  args: string[];
  exitCode: number;
  /** Combined stdout/stderr, truncated. */
  output: string;
  /** Absolute path to the saved output file (latest run per command). */
  outputPath?: string;
  /** Absolute path to the run's diagnostic report (overview + error), when one was written. */
  diagnosticPath?: string;
  /**
   * Absolute path to the structured data report's JSON (`<command>.report.json`),
   * when the command wrote one this run. The `.csv` sibling sits next to it.
   */
  reportPath?: string;
  /** Unix ms when the run started. */
  startedAt: number;
  /** Duration in ms. */
  durationMs: number;
}

/**
 * A parsed summary of one diagnostic report (the admin "Diagnostics" panel lists
 * these; the full report + companion log are fetched on demand via the file API).
 */
export interface DiagnosticSummary {
  /** Report file path, relative to the output dir (e.g. `diagnostics/run-foo-….report.json`). */
  path: string;
  /** Companion JSONL log path, when present. */
  logPath?: string;
  activity: string;
  intent?: string;
  status: 'ok' | 'warn' | 'error';
  correlationId: string;
  startedAt: string;
  durationMs: number;
  /** Error bucket, when the activity failed. */
  errorClass?: string;
  /** A one-line error message, when the activity failed. */
  errorMessage?: string;
  counts: { steps: number; warnings: number; errors: number; shapeMismatches: number };
  /** File mtime (Unix ms) — newest first in the list. */
  modifiedAt: number;
  /** Report file size in bytes. */
  size: number;
}

/** One script-output file under the configured output dir (the "Files" tab). */
export interface OutputFile {
  /** Path relative to the output dir (forward-slashed, may include subdirs). */
  path: string;
  /** Bare file name (last path segment). */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time (Unix ms). */
  modifiedAt: number;
}

/** A run snapshot kept on purpose (archived from the UI). */
export interface ArchiveRecord extends RunRecord {
  /** Unix ms when it was archived. */
  archivedAt: number;
}

/**
 * One entry in the append-only run history. Unlike `runs` (latest per command),
 * every run is kept here (pruned to the most recent N per command) so the UI can
 * show a "when did I run what, and what came out" timeline.
 */
export interface RunHistoryRecord extends RunRecord {
  /** A registry command, or a user-saved command. */
  source: 'builtin' | 'saved';
}

/** How a saved command runs. */
export type SavedCommandKind = 'shell' | 'builtin';

/**
 * A user-saved command. Two flavours:
 *   - "shell"   — an arbitrary shell command line the user authored (run with bash).
 *   - "builtin" — a saved invocation of a registry command with preset args.
 * Either way, runs are recorded in the run history.
 */
export interface SavedCommand {
  id: string;
  name: string;
  description: string;
  kind: SavedCommandKind;
  /** "shell": the shell command line. "builtin": the registry command name. */
  command: string;
  /** "builtin": preset args passed to the command. Unused for "shell". */
  args: string[];
  /** "shell": working directory to run in (optional; defaults to the repo root). */
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  /** Times this saved command has been run (from command_stats), if ever. */
  runCount?: number;
  /** Unix ms of the most recent run, if ever. */
  lastRunAt?: number;
  /**
   * Tech tags (computed server-side): for a saved builtin, the underlying
   * command's tags; plus the tags of the target app resolved from cwd/args.
   */
  tags?: string[];
}

/** Create (no id) or update (with id) a saved command. */
export interface SaveCommand {
  id?: string;
  name: string;
  description?: string;
  kind: SavedCommandKind;
  command: string;
  args?: string[];
  cwd?: string;
}

export interface RunResult {
  run: RunRecord;
}

/** Acknowledgement for a backgrounded run (the result arrives over the socket). */
export interface RunAccepted {
  accepted: true;
  command: string;
}

/**
 * Messages pushed over the WebSocket (/ws) for live updates. "hello" greets a
 * new connection; "run:started"/"run:completed" track a command's lifecycle —
 * e.g. fire a background deploy and get notified when it finishes.
 */
export type ServerEvent =
  | { type: 'hello' }
  | { type: 'run:started'; command: string; args: string[] }
  | { type: 'run:completed'; run: RunRecord }
  // Automation runs (the Playwright builder). step events stream live; the
  // session:* events come from the headed build browser (picker/recorder).
  | { type: 'automation:run:started'; automation: string }
  | { type: 'automation:step'; automation: string; result: import('./automation').StepResult }
  // heldOpen: a headed run failed and the browser was left open for inspection.
  | { type: 'automation:run:completed'; run: import('./automation').AutomationRunRecord; heldOpen?: boolean }
  // A held-open headed browser (kept after a failed/keep-open run) was closed —
  // by the user shutting the window, not by us — so the UI can clear its banner.
  | { type: 'automation:browser:closed'; automation: string }
  // Live step-through executor state (cursor + mode); shares automation:step results.
  | {
      type: 'automation:step:state';
      automation: string;
      mode: 'idle' | 'step' | 'play';
      cursor: string | null;
      paused?: boolean;
      done?: boolean;
    }
  | { type: 'session:picked'; target: import('./automation').Target; selector: string }
  | { type: 'session:recorded-step'; step: import('./automation').Step }
  | { type: 'session:navigated'; url: string }
  // The unified build session also captured a moment (HTML + screenshot) while
  // "Capture screens" is on; `id` is the capture session, `count` the running total.
  | {
      type: 'session:captured';
      id: string;
      count: number;
      kind: import('./capture').CaptureEntryKind;
      url: string;
    }
  | { type: 'session:closed' }
  // Custom-script runs (in-process registered fns or discovered ~/.rubato/scripts).
  | { type: 'script:run:started'; script: string; runDir?: string }
  | { type: 'script:output'; script: string; chunk: string }
  | {
      type: 'script:run:completed';
      script: string;
      status: import('./pipeline').StageStatus;
      outputPath?: string;
      /** The per-run working dir this run used — surfaced so the UI can open it. */
      runDir?: string;
      durationMs: number;
    }
  // Pipeline runs — the stage list lights up as each stage starts/finishes.
  | { type: 'pipeline:run:started'; pipeline: string; dir: string }
  | {
      type: 'pipeline:stage';
      pipeline: string;
      stageId: string;
      label: string;
      kind: import('./pipeline').PipelineStageKind;
      status: 'running' | 'passed' | 'failed' | 'skipped';
    }
  | { type: 'pipeline:run:completed'; run: import('./pipeline').PipelineRunRecord }
  // Ask-about-your-repo. Every variant carries conversationId + messageId so the
  // UI can route tokens to the right in-flight message under the global broadcast.
  | { type: 'ask:started'; conversationId: string; messageId: string; app?: string; question: string }
  | { type: 'ask:token'; conversationId: string; messageId: string; text: string }
  | { type: 'ask:thinking'; conversationId: string; messageId: string; text: string }
  // Transient human-readable progress ("Searching the codebase…", "Reading routes.tsx")
  // so the user sees activity during retrieval/tool rounds before answer tokens flow.
  | { type: 'ask:status'; conversationId: string; messageId: string; text: string }
  | {
      type: 'ask:tool_call';
      conversationId: string;
      messageId: string;
      toolCallId: string;
      tool: string;
      input?: unknown;
    }
  | {
      type: 'ask:tool_result';
      conversationId: string;
      messageId: string;
      toolCallId: string;
      result?: unknown;
      isError?: boolean;
    }
  | { type: 'ask:title'; conversationId: string; title: string }
  // Post-generation code checks found issues; one self-repair turn is now streaming
  // a corrected answer over the same messageId. `issues` is a short human summary.
  | { type: 'ask:repair_started'; conversationId: string; messageId: string; issues: string[] }
  | { type: 'ask:done'; conversationId: string; messageId: string; message: ChatMessage }
  | { type: 'ask:error'; conversationId: string; messageId: string; error: string }
  | { type: 'index:status'; status: IndexStatus };

// ── Ask-about-your-repo (local RAG chat) ─────────────────────────────────────

export type ChatRole = 'user' | 'assistant';

/** A retrieval-provider key; "auto" picks hybrid when a model is staged, else bm25. */
export type Scorer = 'auto' | 'bm25' | 'embedding' | 'hybrid';

/** A tool call/result pair surfaced by a provider that uses tools. */
export interface ToolEvent {
  toolCallId: string;
  tool: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
}

/** A retrieved chunk cited as context for an answer. */
export interface AskSource {
  relativePath: string;
  startLine: number;
  endLine: number;
  score: number;
}

/**
 * One timed span in an assistant answer's pipeline — surfaced in the UI debug
 * panel so you can see what happened behind a message (retrieval rounds, planner
 * checks, tool calls, the final LLM stream) and how long each took. `startMs` is
 * relative to the start of the answer, so steps lay out as a little timeline.
 */
export interface TraceStep {
  label: string;
  kind: 'index' | 'retrieval' | 'planner' | 'llm' | 'tool' | 'answer' | 'vision';
  /** Offset from the start of the answer, in ms. */
  startMs: number;
  durationMs: number;
  /** Extra context (a tool name, a follow-up query, a planner verdict). */
  detail?: string;
  /** false marks a step that errored/degraded (e.g. a failed tool call). */
  ok?: boolean;
}

/** The full timing/decision trace behind one assistant message. */
export interface MessageTrace {
  /** Wall-clock from the start of the answer to its completion, in ms. */
  totalMs: number;
  /** Which gather strategy ran: the tool-calling agent, the self-ask loop, or a
   * general (no-repo) chat with no retrieval. */
  mode: 'agentic' | 'self-ask' | 'general';
  /** Retrieval rounds (self-ask) or model tool-rounds (agentic). */
  rounds: number;
  /** How many tool calls the agent made (0 for self-ask). */
  toolCalls: number;
  model?: string;
  steps: TraceStep[];
}

/** One message in a conversation, persisted by the server. */
export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  /** Assistant-only: streamed reasoning, when the provider emits it. */
  thinking?: string;
  /** Assistant-only: tool call/result events, when the provider uses tools. */
  toolEvents?: ToolEvent[];
  /** Assistant-only: the chunks retrieved as context for this answer. */
  sources?: AskSource[];
  /** Model id that produced an assistant message. */
  model?: string;
  /** Assistant-only: timing/decision trace, shown in the UI's debug panel. */
  trace?: MessageTrace;
  createdAt: number;
}

/** A conversation thread. Scoped to a registered app, or general (no app). */
export interface Conversation {
  id: string;
  /** App name (registry key) the conversation is about; absent for general chat. */
  app?: string;
  title?: string;
  /** A folder the AI may explore (general chat pointed at a directory). */
  fsRoot?: string;
  createdAt: number;
  updatedAt: number;
}

/** A file attached to a question, sent as ad-hoc context (text only). */
export interface AskAttachment {
  name: string;
  content: string;
}

/** GET /api/conversations/:id → a conversation plus its messages. */
export interface ConversationDetail {
  conversation: Conversation;
  messages: ChatMessage[];
}

export type IndexState = 'missing' | 'indexing' | 'indexed' | 'stale' | 'error';

/** GET /api/index/:app/status — the state of an app's context index. */
export interface IndexStatus {
  app: string;
  state: IndexState;
  /** Which retriever the stored index supports. */
  scorer?: Exclude<Scorer, 'auto'>;
  files?: number;
  chunks?: number;
  model?: string;
  lastIndexedAt?: number;
  error?: string;
  /** Non-fatal advisory shown after a successful index (e.g. indexed a stale backup path). */
  warning?: string;
}

/** POST /api/ask acknowledgement — the answer is persisted (Phase 1) / streams over /ws (Phase 2). */
export interface AskAccepted {
  conversationId: string;
  messageId: string;
}

/** Shape of GET /api/health. */
export interface Health {
  ok: true;
  apps: number;
  commands: number;
}

/** A README-like doc found at the root of an app's directory. */
export interface AppReadme {
  /** The file name as found on disk, e.g. "README.md". */
  name: string;
  /** The file contents (capped). Usually markdown — the UI renders it. */
  content: string;
}

/** Working-tree git state for an app's directory. */
export interface AppGitStatus {
  isRepo: boolean;
  branch?: string;
  /** Commits ahead of upstream (when an upstream is configured). */
  ahead?: number;
  /** Commits behind upstream (when an upstream is configured). */
  behind?: number;
  /** `git status --porcelain` lines (changed/untracked), one per entry. */
  entries: string[];
}

/** Which systems an app touches — drives which detail-page sections render + refresh. */
export interface AppSources {
  git: boolean;
  jenkins: boolean;
  quay: boolean;
  openshift: boolean;
  gitlab: boolean;
  github: boolean;
}

/** Shape of GET /api/apps/:name/details — extra, live info about one app. */
export interface AppDetails {
  /** The resolved registry name of the app. */
  app: string;
  /** The app's README, when one exists at its root. */
  readme?: AppReadme;
  /** Live git status of the app's directory, when it's a git repo. */
  git?: AppGitStatus;
  /** Which cross-domain systems apply to this app (jenkins/quay/openshift/…). */
  sources?: AppSources;
}

/** A positional argument a command accepts (for the web "run" form). */
export interface CommandArg {
  /** Short label / placeholder, e.g. "app", "env". */
  name: string;
  description: string;
  required?: boolean;
  /**
   * A concrete sample value, shown as the input's placeholder so the expected
   * format is obvious. For variadic args, show several space-separated values
   * (e.g. ".vscode/ build/ *.log") to make the format clear.
   */
  example?: string;
}

/** A flag a command accepts. `takesValue` flags render a value input. */
export interface CommandFlag {
  /** Including the leading dashes, e.g. "--dry-run", "--seed". */
  flag: string;
  description: string;
  takesValue?: boolean;
  /** For `takesValue` flags: a sample value shown as the value input's placeholder. */
  example?: string;
}

/** A ready-to-run example (just the args after the command name). */
export interface CommandExample {
  args: string;
  note?: string;
}

/** Optional rich metadata used by the web UI's run form. */
export interface CommandMeta {
  args?: CommandArg[];
  flags?: CommandFlag[];
  examples?: CommandExample[];
  /**
   * Tech tags describing what the command involves (e.g. ['git'],
   * ['deploy','jenkins']). Shown as chips on the Commands page.
   */
  tags?: string[];
}

/** A command as served to the UI (registry entry minus the script path). */
export interface CommandInfo extends CommandMeta {
  name: string;
  description: string;
  kind: string;
  /** Times this command has been run (from command_stats), if ever. */
  runCount?: number;
  /** Unix ms of the most recent run, if ever. */
  lastRunAt?: number;
}

// ── Splunk query builder ─────────────────────────────────────────────────────

/** A saved Splunk query template, as surfaced to the UI form. */
export interface SplunkSearchInfo {
  label: string;
  /** The template's trailing search fragment, shown as a hint/placeholder. */
  search?: string;
}

/** GET /api/splunk/apps → one entry per app with Splunk config, for the builder form. */
export interface SplunkAppInfo {
  /** Registry app name. */
  app: string;
  /** Resolved `${app}` value (configured appId, else the app's directory name). */
  appId: string;
  /** Resolved default index (app, else global). */
  index?: string;
  /** Environments to offer (app, else global defaults). */
  envs: string[];
  /** Saved query templates. */
  searches: SplunkSearchInfo[];
}

/** POST /api/splunk/query request — the builder form's inputs. */
export interface SplunkQueryRequest {
  /**
   * Registry app to build from. Omit (or leave blank) for a **custom** query
   * unrelated to any configured app — the builder then uses only global defaults
   * + the inline inputs below, and `appId` supplies `${app}`.
   */
  app?: string;
  /** Value for `${app}` in custom (app-less) mode; ignored when `app` is set. */
  appId?: string;
  env?: string;
  /** Saved-search label to start from. */
  search?: string;
  /** Per-call overrides. */
  index?: string;
  domain?: string;
  fragment?: string;
  /** Free-text terms appended to the end. */
  extra?: string;
  /** Extra `${name}` interpolation variables. */
  vars?: Record<string, string>;
}

/** POST /api/splunk/query response. */
export interface SplunkQueryResponse {
  /** The assembled query string. */
  query: string;
  /** Variables referenced by a template but missing a value (UI flags these). */
  missing: string[];
}

/** GET /api/splunk/status → whether Splunk keys are configured (gates the Run button). */
export interface SplunkStatus {
  configured: boolean;
  /** Global Splunk defaults, so the app-less "custom query" builder can prefill. */
  defaults?: {
    index?: string;
    domain?: string;
    envs?: string[];
  };
}

/** POST /api/splunk/run request — build the query, then execute it against Splunk. */
export interface SplunkRunRequest extends SplunkQueryRequest {
  /** Search-window start (Splunk time syntax, e.g. "-24h"). Default "-24h". */
  earliest?: string;
  /** Search-window end. Default "now". */
  latest?: string;
  /** Max rows to return. Default 100. */
  count?: number;
}

/** POST /api/splunk/run response — the executed query plus its result rows. */
export interface SplunkRunResponse {
  /** The query that was run. */
  query: string;
  /** Field names in column order. */
  fields: string[];
  /** Result rows (field→value maps). */
  rows: Array<Record<string, unknown>>;
  /** Number of rows returned. */
  count: number;
}

// ── Service catalog (generic runner for the HTTP service clients) ─────────────

/** A parameter an operation accepts (string-typed in the form; coerced server-side). */
export interface ServiceParamInfo {
  name: string;
  label: string;
  required?: boolean;
  placeholder?: string;
}

/** One read operation a service exposes. */
export interface ServiceOperationInfo {
  key: string;
  label: string;
  params: ServiceParamInfo[];
}

/** GET /api/services → one entry per catalogued service. */
export interface ServiceInfo {
  /** Stable key, e.g. "datadog". */
  name: string;
  /** Display label, e.g. "Datadog". */
  label: string;
  /** Whether the service's base URL + secrets are configured. */
  configured: boolean;
  /** Which env keys to set when it isn't configured (shown in the UI). */
  envHint: string;
  operations: ServiceOperationInfo[];
}

/** POST /api/services/run request. */
export interface ServiceRunRequest {
  service: string;
  operation: string;
  params?: Record<string, string>;
}

/** POST /api/services/run response (result is the raw client return value). */
export interface ServiceRunResponse {
  result: unknown;
}

// ── Saved tools (Tools tab persistence) ──────────────────────────────────────

/** A saved curl/fetch request — the full builder input plus a name. */
export interface SavedCurlRequest {
  id: string;
  name: string;
  /** The request shape the builder renders from. */
  request: CurlRequestInput;
  createdAt: number;
  updatedAt: number;
}

/** Create (no id) or update (with id) a saved curl request. */
export interface SaveCurlRequest {
  id?: string;
  name: string;
  request: CurlRequestInput;
}

/** A saved regex — pattern + flags plus a title and free-form notes. */
export interface SavedRegex {
  id: string;
  title: string;
  pattern: string;
  flags: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

/** Create (no id) or update (with id) a saved regex. */
export interface SaveRegex {
  id?: string;
  title: string;
  pattern: string;
  flags: string;
  notes?: string;
}

/** A saved cron schedule — the expression plus a title and free-form notes. */
export interface SavedCron {
  id: string;
  title: string;
  expression: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

/** Create (no id) or update (with id) a saved cron schedule. */
export interface SaveCron {
  id?: string;
  title: string;
  expression: string;
  notes?: string;
}
