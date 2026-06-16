/**
 * Dashboard API: aggregate per-app status across every registered app.
 *
 *   GET  /api/dashboard       → DashboardData (git-only facts for all apps)
 *   POST /api/dashboard/tag   → tag a commit on a set of apps
 *
 * This iteration uses only local git (no external service credentials), so it
 * works out of the box for every cloned app. Each app is read best-effort and in
 * parallel; a repo that can't be read yields a row with `errors` rather than
 * failing the whole response. Service-backed columns (Jenkins/Quay/deployed
 * version) layer on later via the existing service clients.
 */

import { type AppConfig, loadApps } from '../lib/apps';
import type { DeployClients } from '../lib/deploy/collect';
import {
  aheadBehind,
  aheadBehindRefs,
  branchCreatedAt,
  currentBranch,
  defaultBranch,
  goneBranches,
  isGitRepo,
  listTags,
  localBranches,
  remoteBranchSet,
  stashCount,
  statusEntries,
  tagCommit,
} from '../lib/git';
import type {
  DashboardAppRow,
  DashboardData,
  DashboardGit,
  TagAppResult,
  TagAppsRequest,
  TagSearchAppResult,
  TagSearchResponse,
} from '../shared/dashboard';
import { collectDeploy } from './dashboardDeploy';
import { json, jsonError, readJsonBody } from './http';

const RECENT_TAGS = 5;

async function gitFacts(dir: string): Promise<DashboardGit | null> {
  if (!(await isGitRepo(dir))) return null;
  // Fan out the independent reads; each is a short git invocation.
  const [branch, def, entries, ab, stashes, locals, remotes, gone, tags] = await Promise.all([
    currentBranch(dir).catch(() => undefined),
    defaultBranch(dir).catch(() => undefined),
    statusEntries(dir).catch(() => []),
    aheadBehind(dir).catch(() => null),
    stashCount(dir).catch(() => 0),
    localBranches(dir).catch(() => [] as string[]),
    remoteBranchSet(dir).catch(() => new Set<string>()),
    goneBranches(dir).catch(() => [] as string[]),
    listTags(dir, { limit: RECENT_TAGS }).catch(() => []),
  ]);

  const localSet = new Set(locals);
  const localOnlyBranches = locals.filter((b) => !remotes.has(b));
  const remoteOnlyBranches = [...remotes].filter((b) => !localSet.has(b));
  // tagCount: a cheap second call without the limit (count only).
  const allTags = await listTags(dir).catch(() => tags);

  // Base-relative facts (vs the default branch) only make sense on a feature
  // branch — skip when we're on the default branch itself or in detached HEAD.
  let aheadOfBase: number | undefined;
  let behindBase: number | undefined;
  let createdAt: string | undefined;
  if (branch && def && branch !== def && branch !== 'HEAD') {
    const [abBase, created] = await Promise.all([
      aheadBehindRefs(dir, def, branch).catch(() => null),
      branchCreatedAt(dir, branch, def).catch(() => null),
    ]);
    aheadOfBase = abBase?.ahead;
    behindBase = abBase?.behind;
    createdAt = created ?? undefined;
  }

  return {
    isRepo: true,
    branch,
    defaultBranch: def,
    ahead: ab?.ahead,
    behind: ab?.behind,
    aheadOfBase,
    behindBase,
    branchCreatedAt: createdAt,
    dirtyCount: entries.length,
    stashCount: stashes,
    localOnlyBranches,
    remoteOnlyBranches,
    goneBranches: gone,
    localBranchCount: locals.length,
    remoteBranchCount: remotes.size,
    tagCount: allTags.length,
    recentTags: tags.map((t) => ({ name: t.name, commit: t.commit, date: t.date })),
  };
}

async function rowFor(app: AppConfig): Promise<DashboardAppRow> {
  const errors: string[] = [];
  let git: DashboardGit | null = null;
  try {
    git = await gitFacts(app.absolutePath);
  } catch (err) {
    errors.push((err as Error).message);
  }
  return { app: app.name, group: app.group, path: app.absolutePath, git, errors };
}

const summarize = (rows: DashboardAppRow[]): DashboardData['summary'] => {
  const repos = rows.filter((r) => r.git?.isRepo);
  const dirty = repos.filter((r) => (r.git?.dirtyCount ?? 0) > 0);
  const ahead = repos.filter((r) => (r.git?.ahead ?? 0) > 0);
  const behind = repos.filter((r) => (r.git?.behind ?? 0) > 0);
  const gone = repos.filter((r) => (r.git?.goneBranches.length ?? 0) > 0);
  const clean = repos.filter(
    (r) =>
      (r.git?.dirtyCount ?? 0) === 0 &&
      (r.git?.ahead ?? 0) === 0 &&
      (r.git?.behind ?? 0) === 0 &&
      (r.git?.goneBranches.length ?? 0) === 0,
  );
  return {
    total: rows.length,
    repos: repos.length,
    dirty: dirty.length,
    ahead: ahead.length,
    behind: behind.length,
    withGoneBranches: gone.length,
    clean: clean.length,
  };
};

async function getDashboard(
  opts: { includeDeploy?: boolean; deployClients?: DeployClients; env?: string } = {},
): Promise<DashboardData> {
  const apps = (await loadApps()).filter((a) => !a.missing);
  const rows = await Promise.all(apps.map(rowFor));
  rows.sort((a, b) => a.app.localeCompare(b.app));
  const data: DashboardData = { rows, generatedAt: Date.now(), summary: summarize(rows) };

  // Deploy info is opt-in (it hits external services): the default board stays
  // git-only and fast. Credential-gated + best-effort, so it never errors.
  if (opts.includeDeploy) {
    const { configured, byApp } = await collectDeploy(apps, opts.deployClients, opts.env);
    data.deployConfigured = configured;
    for (const row of rows) {
      const d = byApp.get(row.app);
      if (d) row.deploy = d;
    }
  }
  return data;
}

/**
 * Normalize a tag ref. Blank, "latest", or "HEAD" (any case) → undefined, which
 * `tagCommit` tags as HEAD — i.e. the latest commit on each app's current branch.
 * So "tag the latest commit across a set" is just `ref: "latest"` (or no ref).
 */
export function resolveTagRef(ref?: string): string | undefined {
  const r = ref?.trim();
  if (!r || /^(latest|head)$/i.test(r)) return undefined;
  return r;
}

async function tagApps(req: Request): Promise<Response> {
  const body = await readJsonBody<TagAppsRequest>(req);
  if (!body?.tag?.trim() || !Array.isArray(body.apps) || body.apps.length === 0) {
    return jsonError('tag and a non-empty apps[] are required', 400);
  }
  const ref = resolveTagRef(body.ref);
  const apps = await loadApps();
  const byName = new Map(apps.map((a) => [a.name, a]));
  const results: TagAppResult[] = await Promise.all(
    body.apps.map(async (name): Promise<TagAppResult> => {
      const app = byName.get(name);
      if (!app) return { app: name, ok: false, error: 'unknown app' };
      if (!(await isGitRepo(app.absolutePath))) return { app: name, ok: false, error: 'not a git repo' };
      const res = await tagCommit(app.absolutePath, body.tag.trim(), {
        ref,
        message: body.message?.trim() || undefined,
      });
      return res.code === 0
        ? { app: name, ok: true }
        : { app: name, ok: false, error: res.stderr.trim() || `git exited ${res.code}` };
    }),
  );
  return json({ results });
}

// GET /api/dashboard/tags?prefix=&limit=&apps= — search tags across apps. Only
// apps with at least one matching tag are returned, each newest-first.
async function searchTags(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const prefix = params.get('prefix')?.trim() || undefined;
  const limit = Number(params.get('limit')) || 50;
  const appsParam = params.get('apps');
  const wanted = appsParam
    ? new Set(
        appsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;

  const apps = (await loadApps()).filter((a) => !a.missing && (!wanted || wanted.has(a.name)));
  const results: TagSearchAppResult[] = await Promise.all(
    apps.map(async (app): Promise<TagSearchAppResult> => {
      if (!(await isGitRepo(app.absolutePath))) return { app: app.name, tags: [] };
      const tags = await listTags(app.absolutePath, { prefix, limit }).catch(() => []);
      return { app: app.name, tags: tags.map((t) => ({ name: t.name, commit: t.commit, date: t.date })) };
    }),
  );
  const body: TagSearchResponse = { prefix: prefix ?? '', results: results.filter((r) => r.tags.length > 0) };
  return json(body);
}

export async function handleDashboardApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/dashboard') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    // ?deploy=1 also resolves each app's latest published image (slower; hits the
    // service clients) — off by default so the git-only board stays fast.
    const params = new URL(req.url).searchParams;
    const includeDeploy = params.get('deploy') === '1';
    const env = params.get('env')?.trim() || undefined;
    return json(await getDashboard({ includeDeploy, env }));
  }
  if (pathname === '/api/dashboard/tags') {
    if (req.method !== 'GET') return jsonError('use GET', 405);
    return searchTags(req);
  }
  if (pathname === '/api/dashboard/tag') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    return tagApps(req);
  }
  return jsonError(`not found: ${pathname}`, 404);
}
