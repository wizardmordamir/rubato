/**
 * Wire types for the Dashboard page — a datadog/dynatrace-style overview that
 * aggregates per-app status across every registered app and lets you filter and
 * chart it. This first iteration covers the GIT-only facts (no external service
 * credentials needed): branch, ahead/behind, dirty-working-tree, local-only vs.
 * remote-only branches, gone upstreams, stash count, and tags. Service-backed
 * columns (Jenkins build, Quay image, deployed version) layer on later.
 */

export interface DashboardGit {
  isRepo: boolean;
  /** Current checked-out branch (or detached HEAD short sha). */
  branch?: string;
  /** The repo's default branch (origin/HEAD → main/master). */
  defaultBranch?: string;
  /** Commits the current branch is ahead/behind its upstream (null = no upstream). */
  ahead?: number;
  behind?: number;
  /**
   * Commits the current branch is ahead/behind the DEFAULT branch (main/master).
   * Set only when the current branch differs from the default — answers "how far
   * ahead of / behind main is this branch?" independent of any upstream.
   */
  aheadOfBase?: number;
  behindBase?: number;
  /** Approx. branch-created date (ISO): earliest commit diverging from the base. */
  branchCreatedAt?: string;
  /** Working-tree change count (`git status --porcelain` lines). */
  dirtyCount: number;
  /** Stash entry count. */
  stashCount: number;
  /** Branch names that exist locally but not on origin. */
  localOnlyBranches: string[];
  /** Branch names on origin but not checked out locally. */
  remoteOnlyBranches: string[];
  /** Local branches whose upstream was deleted on the remote. */
  goneBranches: string[];
  /** Total local + total remote branch counts (for the "both" math in the UI). */
  localBranchCount: number;
  remoteBranchCount: number;
  /** Tag count + the most recent few (name/commit/date), newest first. */
  tagCount: number;
  recentTags: DashboardTag[];
}

export interface DashboardTag {
  name: string;
  commit: string;
  date: string;
}

/**
 * The latest published deployable image for an app — resolved from the service
 * clients (Quay tag + its digest, enriched with the latest Jenkins build). Only
 * present when deploy info was requested AND credentials are configured; service
 * gaps degrade to `available:false` + an `error`, never a thrown request. (This is
 * the latest *published* image; true per-env deployed state — rancher/openshift —
 * is a further iteration.)
 */
export interface DashboardDeploy {
  available: boolean;
  /** Quay tag name, e.g. "1.2.3". */
  version?: string;
  /** Bare image digest (no "sha256:" prefix). */
  imageSha?: string;
  /** Full manifest digest, e.g. "sha256:deadbeef…". */
  imageDigest?: string;
  /** Latest Jenkins build number (enrichment). */
  buildNumber?: number;
  /** Git commit the build was built from (completes version↔sha↔commit). */
  commit?: string;
  /** ISO time of the latest Jenkins build, when known. */
  publishedAt?: string;
  /** The environment this was resolved for (e.g. "prod", "stage"), when scoped. */
  env?: string;
  /** First soft service error (e.g. "quay: 404"), when resolution partly failed. */
  error?: string;
}

export interface DashboardAppRow {
  app: string;
  /** Parent group (scan-root-relative) for grouping/filtering. */
  group: string | null;
  path: string;
  git: DashboardGit | null;
  /** Per-app soft errors (a repo that couldn't be read, etc.) — never fatal. */
  errors: string[];
  /** Latest published image (only when ?deploy=1 and creds are configured). */
  deploy?: DashboardDeploy;
}

export interface DashboardData {
  rows: DashboardAppRow[];
  generatedAt: number;
  /** When deploy info was requested: whether any service client was configured. */
  deployConfigured?: boolean;
  /** Roll-ups for the summary charts. */
  summary: {
    total: number;
    repos: number;
    dirty: number; // repos with uncommitted changes
    ahead: number; // repos ahead of upstream
    behind: number; // repos behind upstream
    withGoneBranches: number;
    clean: number; // repos with nothing to report (no dirty/ahead/behind/gone)
  };
}

/** POST /api/dashboard/tag — tag a commit on one or more apps. */
export interface TagAppsRequest {
  /** App names to tag (the UI's current selection/filter). */
  apps: string[];
  /** Tag name to create. */
  tag: string;
  /**
   * What to tag on each app (commit/branch/ref). Blank, "latest", or "HEAD" all
   * mean each app's latest commit on its current branch (the default).
   */
  ref?: string;
  /** Annotated-tag message (lightweight when omitted). */
  message?: string;
}

export interface TagAppResult {
  app: string;
  ok: boolean;
  error?: string;
}

/**
 * GET /api/dashboard/tags?prefix=&limit=&apps= — search tags across apps.
 * Answers "what tags does each app have?" and "find commits with tags starting
 * with <text>". Only apps with at least one matching tag are returned.
 */
export interface TagSearchAppResult {
  app: string;
  tags: DashboardTag[];
}

export interface TagSearchResponse {
  prefix: string;
  results: TagSearchAppResult[];
}
