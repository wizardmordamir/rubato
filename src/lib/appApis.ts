/**
 * Per-app metadata schema: the optional fields a user adds to an app entry in
 * ~/.rubato/apps.json beyond what `rubato-scan` derives.
 *
 * The point is configuration: anything that differs between machines or projects
 * (which Jenkins project an app maps to, whether it's a multibranch pipeline,
 * per-environment job paths, ...) lives here as data, with global defaults in
 * ~/.rubato/config.json and per-app overrides taking precedence.
 */

import type { FooocusPerformance } from '../shared/art';
import type { FooocusMemoryConfig } from '../shared/fooocus';

/** Databases an app uses (informational; extend as needed). */
export enum Db {
  Mongo = 'mongo',
  Mssql = 'mssql',
  Postgres = 'postgres',
  Mysql = 'mysql',
  Redis = 'redis',
  Sqlite = 'sqlite',
}

/**
 * Categories of potentially-destructive commands an app can opt out of, so a
 * sensitive repo isn't touched by bulk operations (delete stale branches, prune
 * stashes, force fetch, redeploy, ...).
 */
export type CommandType = 'git' | 'deploy' | 'build' | 'clean';

/** Per-environment Jenkins config/overrides for an app. */
export interface JenkinsEnvConfig {
  /** Environment name, e.g. "dev", "test", "stage", "prod". */
  envName: string;
  /**
   * Explicit Jenkins job path for this env, "/"-separated folder segments
   * (e.g. "Deploys/my-app" or "Deploys/my-app/main"). Overrides all resolution.
   */
  jobPath?: string;
  /** Project/folder name for this env if it differs from the app's `project`. */
  projectName?: string;
  /** Default git branch built for this env (e.g. "main", "stage"). */
  branch?: string;
  /** Whether this env's job is a multibranch pipeline (overrides app/global). */
  multibranch?: boolean;
}

/**
 * How to recover the release version a Jenkins build produced, so a deploy-list
 * version ("1.1.13.739") can be matched back to its build. The version rarely
 * maps cleanly (displayName is often just "#740", and the trailing segment is
 * off-by-one from the build number), so this is configuration, not a hardcoded
 * rule. Used only as best-effort enrichment by `verifyshas` — never a hard gate.
 */
export interface JenkinsVersionStrategy {
  /** Where the version lives: a dotted string in the build name, or a build parameter. Default "displayName". */
  source?: 'displayName' | 'param';
  /** Parameter name holding the version when `source` is "param" (e.g. "IMAGE_VERSION"). */
  param?: string;
  /** Allow matching by the version's trailing segment as a build number (low-confidence). Default true. */
  buildNumberFallback?: boolean;
}

/**
 * Global Jenkins conventions (per computer), stored under `jenkins` in
 * ~/.rubato/config.json. Per-app and per-env config override these.
 */
export interface JenkinsDefaults {
  /** Treat apps as multibranch pipelines unless an app/env says otherwise. */
  multibranch?: boolean;
  /** Known environment names, e.g. ["dev", "test", "stage", "prod"]. */
  envs?: string[];
  /** Known pipeline types, e.g. ["deploy", "scan"]. */
  pipelines?: string[];
  /** Default version→build recovery strategy; per-app overrides take precedence. */
  versionStrategy?: JenkinsVersionStrategy;
}

/** The `jenkins` block of the global rubato config. */
export interface JenkinsGlobalConfig {
  /** Jenkins base URL; falls back to the JENKINS_URL env var when omitted. */
  baseUrl?: string;
  /** Default conventions applied to every app unless overridden. */
  defaults?: JenkinsDefaults;
}

/** Jenkins integration config for an app. */
export interface JenkinsAppApi {
  name: 'jenkins';
  /** Base Jenkins project/folder for this app; may contain "/" for nested folders. */
  project?: string;
  /** Multibranch pipeline by default for this app? Overrides the global default. */
  multibranch?: boolean;
  /** Per-environment configuration and overrides. */
  envs?: JenkinsEnvConfig[];
  /** Version→build recovery strategy for this app; overrides the global default. */
  versionStrategy?: JenkinsVersionStrategy;
}

/** GitLab integration config for an app. */
export interface GitlabAppApi {
  name: 'gitlab';
  /** Project (repo) name or path within the namespace. */
  project: string;
  /** Group/namespace the project lives under. */
  namespace?: string;
  /** Override the global GitLab base URL for this app. */
  baseUrl?: string;
}

/** Quay (container registry) integration config for an app. */
export interface QuayAppApi {
  name: 'quay';
  /** Repository as "namespace/name". */
  repository: string;
  baseUrl?: string;
}

/** OpenShift integration config for an app — chiefly which project/namespace it runs in. */
export interface OpenshiftAppApi {
  name: 'openshift';
  /** OpenShift project / k8s namespace the app's workloads live in (e.g. "my-app-prod"). */
  namespace?: string;
  /** Per-environment namespaces, e.g. { dev: "my-app-dev", prod: "my-app-prod" } — overrides `namespace` when an env is given. */
  namespaces?: Record<string, string>;
}

/** Global config for a service whose base URL/conventions are machine-wide. */
export interface ServiceGlobalConfig {
  /** Base URL; falls back to the service's *_URL env var when omitted. */
  baseUrl?: string;
}

/**
 * OpenShift global config. `baseUrl` is the cluster API server (direct path).
 * `consoleUrl` is the web-console base — used as a FALLBACK transport when the
 * direct API is blocked: the console proxies the k8s API at
 * `<consoleUrl>/api/kubernetes`, reachable with the console session token
 * (OPENSHIFT_CONSOLE_TOKEN). Falls back to the OPENSHIFT_CONSOLE_URL env var.
 */
export interface OpenshiftGlobalConfig extends ServiceGlobalConfig {
  /** OpenShift web-console base URL (e.g. https://console-openshift-console.apps.cluster). */
  consoleUrl?: string;
}

/** Escape hatch for services without a dedicated type yet (openshift, rancher, harness, ...). */
export interface GenericAppApi {
  name: string;
  [key: string]: unknown;
}

// ── Splunk query builder ─────────────────────────────────────────────────────

/**
 * A reusable, named Splunk query template for an app. Picking one in the UI
 * pre-fills the index/domain/search slots; each field is optional and falls back
 * to the app's defaults, then the global ones. `${app}`/`${env}` (and any custom
 * `${var}`) interpolate when the query is built.
 */
export interface SplunkSearch {
  /** Human label shown in the picker, e.g. "Audit logs". */
  label: string;
  /** Override the index (log source) for this search. */
  index?: string;
  /** Override the domain pattern for this search (supports `${app}`/`${env}`). */
  domain?: string;
  /** Trailing search fragment — a path or SPL, supports `${app}`/`${env}`/`${var}`. */
  search?: string;
}

/** Splunk integration config for an app. */
export interface SplunkAppApi {
  name: 'splunk';
  /** Default index (log source) for this app, e.g. "main". */
  index?: string;
  /** Value substituted for `${app}` (defaults to the app's directory name). */
  appId?: string;
  /** Domain-filter pattern, supports `${app}`/`${env}`. Default `${app}-${env}`. */
  domain?: string;
  /** Known environments for this app, e.g. ["dev", "test", "prod"]. */
  envs?: string[];
  /** Named, reusable query templates. */
  searches?: SplunkSearch[];
}

/** Global Splunk conventions (per computer); per-app/per-search config overrides these. */
export interface SplunkDefaults {
  /** Default index when an app/search doesn't specify one. */
  index?: string;
  /** Default domain pattern, supports `${app}`/`${env}`. Default `${app}-${env}`. */
  domain?: string;
  /** Known environment names applied to apps that don't list their own. */
  envs?: string[];
  /** How the domain filter renders around `${domain}`. Default `dom IN("${domain}")`. */
  domainClause?: string;
}

/** The `splunk` block of the global rubato config. */
export interface SplunkGlobalConfig {
  /** Splunk base URL (reserved for a future "open in Splunk" link; not needed to build queries). */
  baseUrl?: string;
  /** Default conventions applied to every app unless overridden. */
  defaults?: SplunkDefaults;
}

/** Any per-app API integration, discriminated by `name`. */
export type AppApi = JenkinsAppApi | GitlabAppApi | QuayAppApi | SplunkAppApi | OpenshiftAppApi | GenericAppApi;

/** The known API `name` values with dedicated types. */
export type KnownApiName = 'jenkins' | 'gitlab' | 'quay' | 'splunk' | 'openshift';

// ── AI / "ask about your repo" config ────────────────────────────────────────

/** Which LLM provider to use; "direct" calls an LLM URL, "form-sse" a form-POST SSE endpoint. */
export type LlmProviderName = 'direct' | 'form-sse';

/** Retriever selection. "auto" → hybrid when an embedding model is staged, else bm25. */
export type Scorer = 'auto' | 'bm25' | 'embedding' | 'hybrid';

/**
 * Per-app AI overrides, stored under `ai` on an app entry in apps.json. Preserved
 * across re-scans (it's not a derived key). Everything is optional — global
 * defaults under config.ai apply when unset.
 */
export interface AppAiConfig {
  /** Override the active LLM provider for this app. */
  provider?: LlmProviderName;
  /** Override the chat model id for this app. */
  model?: string;
  /** Override the embedding model id for this app. */
  embeddingModel?: string;
  /** Override retriever selection for this app. */
  scorer?: Scorer;
  /** Extra glob patterns to include (default: all text/source files). */
  include?: string[];
  /** Glob patterns to exclude from indexing. */
  exclude?: string[];
  /** Token budget for assembled context (overrides the global default). */
  maxContextTokens?: number;
  /** Max prior conversation messages replayed for multi-turn memory. Overrides global. */
  maxHistoryMessages?: number;
  /** Token budget for the replayed history. Overrides global. */
  maxHistoryTokens?: number;
  /** Max retrieval rounds for the self-ask loop (1 = single-shot). Overrides global. */
  maxRetrievalRounds?: number;
  /** Expand ranked files to their sibling chunks before answering. Overrides global. */
  expandFiles?: boolean;
  /** Let the model gather context with tools (agentic RAG). Overrides global. */
  tools?: boolean;
  /** Max tool rounds when `tools` is on. Overrides global. */
  maxToolRounds?: number;
  /** Override the chat transport for this app ("ollama" enables native `/api/chat` options). */
  flavor?: LlmFlavor;
  /** Sampling temperature override (ollama flavor). */
  temperature?: number;
  /** Context window (num_ctx) override (ollama flavor). */
  numCtx?: number;
  /** Repeat-penalty override (ollama flavor). */
  repeatPenalty?: number;
  /** Nucleus sampling top_p override (ollama flavor). */
  topP?: number;
  /** Reasoning toggle/budget for thinking-capable models (ollama flavor). */
  think?: boolean | 'low' | 'medium' | 'high';
  /** Cross-encoder re-ranking of retrieval candidates. Overrides global. */
  rerank?: boolean;
  /** Cross-encoder model id for re-ranking. Overrides global. */
  rerankModel?: string;
  /**
   * Inject a `[Runtime Reference]` block (Bun version, app path, key deps, probed CLI
   * versions) + code-generation rules into the system prompt for code-shaped questions.
   * Overrides global. Default true.
   */
  codeGrounding?: boolean;
  /**
   * After a code-shaped answer, run in-process syntax/async/path checks and, if any
   * fire, do one self-repair turn before persisting. Auto-skips when the effective
   * num_ctx < 8192 (the repair turn re-sends the first answer). Overrides global.
   * Default true.
   */
  codeEnhance?: boolean;
  /**
   * Additionally run `tsc --noEmit` over extracted code blocks during codeEnhance.
   * Noisy on fragments (missing imports/ambient types); best for complete-file
   * snippets. Overrides global. Default false.
   */
  codeEnhanceTsc?: boolean;
  /**
   * Local vision model for the screenshot-extraction step when a question carries
   * images (requires `flavor: "ollama"`). Overrides global. Default "qwen3-vl:8b".
   */
  visionModel?: string;
}

/** Chat transport shape for a direct endpoint: OpenAI-compat `/v1` or Ollama-native `/api/chat`. */
export type LlmFlavor = 'openai' | 'ollama';

/** A direct LLM endpoint: an OpenAI-compatible (or custom-shaped) chat URL. */
export interface DirectLlmConfig {
  /** Base URL of the LLM/agent endpoint. Falls back to RUBATO_LLM_URL. */
  baseUrl?: string;
  /** Path appended to baseUrl for chat. Default "chat/completions". */
  path?: string;
  /** Default chat model id. */
  model?: string;
  /**
   * Transport flavor. "openai" (default) → OpenAI-compat `/v1/chat/completions`.
   * "ollama" → native `/api/chat`, the only path that honors `num_ctx`/`repeat_penalty`.
   */
  flavor?: LlmFlavor;
  /** Sampling temperature (ollama flavor; default 0.1 for grounded code answers). */
  temperature?: number;
  /** Context window size — Ollama `num_ctx` (ollama flavor; e.g. 32768). */
  numCtx?: number;
  /** Repeat penalty — Ollama `repeat_penalty` (ollama flavor; e.g. 1.1). */
  repeatPenalty?: number;
  /** Nucleus sampling — Ollama `top_p` (ollama flavor; e.g. 0.9). */
  topP?: number;
  /** Reasoning toggle/budget for thinking-capable models (ollama flavor). */
  think?: boolean | 'low' | 'medium' | 'high';
}

/** A generic multipart-form-POST endpoint that returns named-event SSE. */
export interface FormSseLlmConfig {
  /** Base URL of the form-POST SSE endpoint. Falls back to RUBATO_FORM_LLM_URL. */
  baseUrl?: string;
  /** Default chat model id. */
  model?: string;
  /** System prompt template the endpoint expects. */
  promptTemplate?: string;
}

/** Embedding settings. "local" runs a staged ONNX model; "remote" calls an endpoint. */
export interface EmbeddingsConfig {
  /** "local" (transformers.js, staged model) or "remote" (OpenAI-compatible /embeddings). Default "local". */
  provider?: 'local' | 'remote';
  /** Model id — e.g. "Xenova/all-MiniLM-L6-v2" (local) or "nomic-embed-text" (remote). */
  model?: string;
  /** Embedding dimension (must match the model). */
  dimensions?: number;
  /** Remote only: base URL of the /embeddings endpoint. Falls back to RUBATO_EMBEDDINGS_URL. */
  baseUrl?: string;
  /** Remote only: path appended to baseUrl. Default "embeddings". */
  path?: string;
}

/**
 * Global AI config, stored under `ai` in ~/.rubato/config.json. Per-app `ai`
 * overrides take precedence; secrets (tokens) live in ~/.rubato/.env.
 */
export interface AiGlobalConfig {
  /** Active LLM provider. Default "direct". */
  provider?: LlmProviderName;
  /** Retriever selection. Default "auto". */
  scorer?: Scorer;
  direct?: DirectLlmConfig;
  formSse?: FormSseLlmConfig;
  embeddings?: EmbeddingsConfig;
  /** Lines per chunk when indexing (default 60). */
  chunkLines?: number;
  /** Overlapping lines between chunks (default 10). */
  chunkOverlap?: number;
  /** Token budget for assembled context (default 6000). */
  maxContextTokens?: number;
  /** Number of chunks retrieved per question (default 12). */
  topK?: number;
  /** Multi-turn memory: max prior messages replayed into the prompt (default 20; 0 = off). */
  maxHistoryMessages?: number;
  /** Token budget for the replayed conversation history (default 3000). */
  maxHistoryTokens?: number;
  /**
   * Self-ask retrieval loop: after each round the LLM judges whether the gathered
   * context is enough and, if not, proposes follow-up searches. This is the cap on
   * rounds — 1 disables the loop (single-shot), 2 (default) allows one follow-up.
   */
  maxRetrievalRounds?: number;
  /** Expand ranked files to their sibling chunks before answering (default true). */
  expandFiles?: boolean;
  /** How many top files to expand per retrieval (default 3). */
  expandMaxFiles?: number;
  /** Cap on chunks pulled per expanded file (default 12). */
  expandMaxChunksPerFile?: number;
  /**
   * Agentic RAG: let the model gather context by calling read-only repo tools
   * (search_repo / read_file / list_files) through a provider-agnostic JSON
   * protocol, instead of one-shot retrieval. Opt-in (default false); degrades to
   * the seeded retrieval if the model never calls a tool.
   */
  tools?: boolean;
  /** Max tool rounds when `tools` is on (default 4). */
  maxToolRounds?: number;
  /**
   * Cross-encoder re-ranking: re-score the top retrieval candidates with a local
   * cross-encoder so the most relevant chunks lead the context. On by default
   * when the rerank model is staged; set false to force off. Falls back to the
   * RRF order when the model/package is absent.
   */
  rerank?: boolean;
  /** Cross-encoder model id used for re-ranking (default "Xenova/ms-marco-MiniLM-L-6-v2"). */
  rerankModel?: string;
  /**
   * Inject a `[Runtime Reference]` block (Bun version, app path, key deps, probed CLI
   * versions) + code-generation rules into the system prompt for code-shaped questions.
   * Default true.
   */
  codeGrounding?: boolean;
  /**
   * Post-generation safety net for code answers: run in-process syntax/async/path
   * checks and, if any fire, do one self-repair turn before persisting. Auto-skips
   * when the effective num_ctx < 8192. Default true.
   */
  codeEnhance?: boolean;
  /**
   * Also run `tsc --noEmit` over extracted code blocks during codeEnhance. Noisy on
   * fragments; best for complete-file snippets. Default false.
   */
  codeEnhanceTsc?: boolean;
  /**
   * Local vision model used for the screenshot-extraction step when a question
   * carries images (requires `flavor: "ollama"`). Default "qwen3-vl:8b".
   */
  visionModel?: string;
}

/** Style preset for local art generation; each maps to a positive/negative modifier. */
export type ArtPresetType = 'web_ui' | 'game_art_2d' | 'abstract_texture' | 'app_icon' | 'raw_creative';

/** Which local diffusion server the art engine talks to (the request/response wiring differs per backend). */
export type ArtBackend = 'fooocus' | 'a1111' | 'comfyui';

/**
 * Local art/image generation settings (global; `~/.rubato/config.json` → `art`).
 * Talks to a local diffusion server; assets are written under
 * `<RUBATO_HOME>/generated-assets/<appId>/` and served via a GET route.
 */
export interface ArtConfig {
  /** Master switch for the art engine + agentic tool. Default true. */
  enabled?: boolean;
  /** Diffusion backend protocol. Default "fooocus" (Fooocus-API). */
  backend?: ArtBackend;
  /** Base URL of the local diffusion server. Default depends on backend (fooocus → http://localhost:8888). */
  url?: string;
  /** Sampling steps (a1111 only; Fooocus derives steps from `performance`). Default 4. */
  steps?: number;
  /**
   * Fooocus style stack applied to every generation — the single biggest quality
   * lever. Default ["Fooocus V2","Fooocus Enhance","Fooocus Sharp"] ("Fooocus V2"
   * is the AI prompt-expansion engine). See src/shared/art.ts.
   */
  styles?: string[];
  /** Fooocus performance preset → step count. Default "Speed" (only Speed/Quality work without extra LoRAs). */
  performance?: FooocusPerformance;
  /** CFG / guidance scale. Default 4.0 (Fooocus-tuned; higher = more literal). */
  guidanceScale?: number;
  /** Fooocus sharpness, 0–30. Default 2.0. */
  sharpness?: number;
  /** Base checkpoint filename (must exist in the Fooocus models dir). Default: the server's own default. */
  baseModel?: string;
  /**
   * Refiner checkpoint filename, or "None" to disable the refiner entirely.
   * Disabling it is a real MEMORY lever — a separate refiner model roughly doubles
   * resident weights. Default: the server's own default (usually "None").
   */
  refinerModel?: string;
  /** When the refiner kicks in (0.1–1.0; 1.0 ≈ never). Default 0.8 (Fooocus default). */
  refinerSwitch?: number;
  /**
   * Default generation width/height when a request doesn't specify one. Lower =
   * less memory + faster. Default 1024×1024. Must be a Fooocus-supported size.
   */
  width?: number;
  height?: number;
  /** Extra negative-prompt terms appended to every generation. Default "". */
  negativePrompt?: string;
}

/**
 * Optional per-machine overrides for one Fooocus server the chat-page control
 * panel can start/stop. Everything is optional — sensible defaults are
 * auto-discovered (the install dir is found by probing known locations; the
 * Python interpreter defaults to the dir's own `.venv/bin/python3`). Only set a
 * field when discovery guesses wrong for your machine.
 */
export interface FooocusServerOverride {
  /** Install directory (the one holding the entry script). Tilde-expanded. */
  dir?: string;
  /** Python interpreter to launch with (absolute path or a PATH name). */
  python?: string;
  /** Port the server listens on (api → 8888, ui → 7865 by default). */
  port?: number;
  /** Entry script filename (api → main.py, ui → launch.py by default). */
  entry?: string;
  /** Extra launch args appended after the entry script. */
  args?: string[];
}

/**
 * Local Fooocus process control (`~/.rubato/config.json` → `fooocus`). Lets the
 * chat-page panel start/stop the Fooocus-API (`api`, art-engine backend) and the
 * standalone Gradio web UI (`ui`). Both blocks are optional overrides over
 * auto-discovery — see {@link FooocusServerOverride}.
 */
export interface FooocusConfig {
  api?: FooocusServerOverride;
  ui?: FooocusServerOverride;
  /**
   * Memory / VRAM tuning, translated into Fooocus launch flags (`memoryArgs`) and
   * appended to BOTH servers' spawn args. The biggest lever on the "running out of
   * RAM" problem. Changing it needs a Fooocus restart to take effect. See
   * src/shared/fooocus.ts.
   */
  memory?: FooocusMemoryConfig;
}
