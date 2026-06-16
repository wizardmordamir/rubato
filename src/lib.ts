/**
 * rubato as a library — the public top-level surface.
 *
 * rubato is both a CLI (memorable shell commands) and an importable toolkit. This
 * barrel exposes the reusable building blocks so another app can piece together
 * its own clients and reports: HTTP/service clients for getting & setting data,
 * git helpers, the app registry/config, table/CSV output, and the deploy
 * correlation/verification toolkit.
 *
 *   import { createApiClient, toTable, loadApps } from "rubato";
 *   import { jenkins, quay, gitlab, git, deploy } from "rubato";   // domain namespaces
 *
 * Each namespace is also a dedicated subpath for flat imports:
 *   import { jenkinsFromConfig } from "rubato/jenkins";
 *   import { currentBranch } from "rubato/git";
 *   import { verifyDeployList } from "rubato/deploy";
 *
 * This barrel is LIBRARY-ONLY: importing "rubato" (or any subpath) never pulls in
 * the local server, web UI, DB (`bun:sqlite`), or Playwright. Apps that want to
 * embed rubato's server + UI import it explicitly from the dedicated entry:
 *   import { on } from "rubato/server"; on();   // boots only when RUBATO_ON=true
 */

// ── Domain namespaces (the full surface of each, collision-free) ─────────────
export * as datadog from './api/datadog';
export * as dynatrace from './api/dynatrace';
export * as github from './api/github';
export * as gitlab from './api/gitlab';
export * as harness from './api/harness';
export * as jenkins from './api/jenkins';
export * as openshift from './api/openshift';
export * as quay from './api/quay';
export * as rancher from './api/rancher';
export * as splunk from './api/splunk';
export * as deploy from './lib/deploy';
export * as git from './lib/git';
// Pure parsers/aggregators for the unattended task-queue workflows (TASKS.md,
// Tasks_Completed.md, runs/*.jsonl). Server-free, so embedders can ingest the
// same control files; the rubato Orchestration page is the in-app consumer.
export * as orchestration from './lib/orchestration';
// Register the embedding app's own in-process scripts (custom functions) —
// runnable from the UI and as pipeline `script` stages:
//   import { registerScript } from "rubato"; registerScript({ id, run });
//   import { on } from "rubato/server"; on();   // boot the server/UI separately
export {
  type RegisteredScript,
  registerScript,
  registerScripts,
  type ScriptRunContext,
} from './lib/scriptRegistry';
// NOTE: the embeddable server (`on()`) is intentionally NOT exported here — it
// pulls in the local server + UI + bun:sqlite. It lives behind the dedicated
// `rubato/server` subpath so this library barrel stays server/UI-free.
export * as request from './shared/request';

// ── Flat universal utilities ─────────────────────────────────────────────────

// Reusable HTTP client (the base every service client is built on) + secrets.
export {
  type ApiClient,
  type ApiClientConfig,
  ApiError,
  type ApiResponse,
  type AuthConfig,
  buildUrl,
  createApiClient,
  type RequestOptions,
  type ResponseType,
} from './api/client';
// Service-client constructors (most-used entry points; full surface via namespaces/subpaths).
export { createDatadogClient, datadogFromConfig } from './api/datadog';
export { createDynatraceClient, dynatraceFromConfig } from './api/dynatrace';
export { optionalEnv, requireEnv } from './api/env';
export { createGithubClient, githubFromConfig } from './api/github';
export { createGitlabClient, gitlabFromConfig } from './api/gitlab';
export { createHarnessClient, harnessFromConfig } from './api/harness';
export { createJenkinsClient, jenkinsFromConfig } from './api/jenkins';
export { createOpenshiftClient, openshiftFromConfig } from './api/openshift';
export { createQuayClient, quayFromConfig } from './api/quay';
export { createRancherClient, rancherFromConfig } from './api/rancher';
export { createSplunkClient, splunkFromConfig } from './api/splunk';

// Global config + the app registry (resolve which app maps to which api).
export type { AppApi } from './lib/appApis';
export { type AppConfig, findMatches, getAppApi, loadApps, saveApps } from './lib/apps';
// AppScan / ASoC vulnerability-report PDF parsing.
export {
  type AppScanReport,
  detectApplication,
  detectScanType,
  extractAppScanReport,
  isAppScanReport,
  parseAppScanPdf,
  parseAppScanReport,
  type ScanType,
  SEVERITIES,
  type Severity,
  tallySeverities,
} from './lib/appscan';
export {
  APPS_FILE,
  CONFIG_FILE,
  ENV_FILE,
  loadConfig,
  RUBATO_HOME,
  type RubatoConfig,
  saveConfig,
} from './lib/config';
export { classifyError, type ErrorClass } from './lib/diagnostics/report';
// Diagnostics — structural shape diffing + error classification for debugging
// against unfamiliar APIs (the impure file-writing session lives in src/lib/diagnostics).
export { describeShape, diffShape, type ShapeDescriptor, type ShapeDiff, shapeToString } from './lib/diagnostics/shape';
// Table / CSV rendering for reports.
export { type Row, toCsv, toTable } from './lib/output';
// Service catalog — list/run read operations across the configured service clients.
export { findService, listServices, runServiceOperation, SERVICE_CATALOG } from './lib/serviceCatalog';
// Pure developer-tool functions (curl/fetch builder, JSON+CSV, regex, YAML) — also
// powering the web "Tools" tab. Full surface (incl. types + regex palettes) via "rubato/tools".
export { buildCurl, buildFetch } from './shared/tools/curl';
export { csvToJson, formatJson, jsonToCsv } from './shared/tools/json';
export { explainRegex, testRegex } from './shared/tools/regex';
export { formatYaml } from './shared/tools/yaml';
