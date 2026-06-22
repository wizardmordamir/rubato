import { DivergingBars } from 'cursedbelt/react/charts';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StatTile } from "cursedbelt/react";
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  Badge,
  CARD_CLASS,
  FIELD_CLASS,
  OpenPathButton,
  PageHeading,
  SearchInput,
  Tooltip,
} from "../components";
import { type DashboardAppRow, fetchDashboard, searchDashboardTags, tagApps } from "../api";

// Short local-date for a branch's approximate creation date (ISO → e.g. Jun 3).
const shortDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

// A filter the per-app rows can be narrowed by. Each is a cheap predicate over
// the already-fetched git facts (no extra round-trips) — the datadog-style
// "show me apps that meet condition X" the dashboard is for.
const FILTERS: { key: string; label: string; test: (r: DashboardAppRow) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "repos", label: "Git repos", test: (r) => !!r.git?.isRepo },
  { key: "dirty", label: "Uncommitted", test: (r) => (r.git?.dirtyCount ?? 0) > 0 },
  { key: "ahead", label: "Ahead", test: (r) => (r.git?.ahead ?? 0) > 0 },
  { key: "behind", label: "Behind", test: (r) => (r.git?.behind ?? 0) > 0 },
  { key: "aheadBase", label: "Ahead of main", test: (r) => (r.git?.aheadOfBase ?? 0) > 0 },
  { key: "behindBase", label: "Behind main", test: (r) => (r.git?.behindBase ?? 0) > 0 },
  { key: "gone", label: "Gone upstreams", test: (r) => (r.git?.goneBranches.length ?? 0) > 0 },
  { key: "localOnly", label: "Local-only branches", test: (r) => (r.git?.localOnlyBranches.length ?? 0) > 0 },
  { key: "tagged", label: "Has tags", test: (r) => (r.git?.tagCount ?? 0) > 0 },
];

// --- Multi-column sort ----------------------------------------------------- //
type SortDir = "asc" | "desc";
type SortEntry = { col: string; dir: SortDir };

// Extracts a comparable value per column for sorting. Strings compare via
// localeCompare; numbers compare arithmetically.
const COL_VALUE: Record<string, (r: DashboardAppRow) => string | number> = {
  app: (r) => r.app.toLowerCase(),
  branch: (r) => r.git?.branch?.toLowerCase() ?? "",
  upstream: (r) => (r.git?.ahead ?? 0) - (r.git?.behind ?? 0),
  main: (r) => (r.git?.aheadOfBase ?? 0) - (r.git?.behindBase ?? 0),
  dirty: (r) => r.git?.dirtyCount ?? 0,
  branches: (r) => r.git?.localBranchCount ?? 0,
  tags: (r) => r.git?.tagCount ?? 0,
  version: (r) => r.deploy?.version?.toLowerCase() ?? "",
};

function sortRows(rows: DashboardAppRow[], keys: SortEntry[]): DashboardAppRow[] {
  if (keys.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const { col, dir } of keys) {
      const va = COL_VALUE[col]?.(a) ?? "";
      const vb = COL_VALUE[col]?.(b) ?? "";
      const cmp =
        typeof va === "string" && typeof vb === "string"
          ? va.localeCompare(vb)
          : (va as number) - (vb as number);
      if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
    }
    return 0;
  });
}

// Clicking the same column (when it's primary) toggles direction; clicking a
// new column pushes it to the front (becomes primary), preserving the prior
// column as secondary tie-breaker.
function nextSortKeys(prev: SortEntry[], col: string): SortEntry[] {
  if (prev[0]?.col === col) {
    return [{ col, dir: prev[0].dir === "asc" ? "desc" : "asc" }, ...prev.slice(1)];
  }
  const existing = prev.find((s) => s.col === col);
  return [{ col, dir: existing?.dir ?? "asc" }, ...prev.filter((s) => s.col !== col)];
}

// Shows ↑/↓ on the primary sorted column and a dimmed secondary indicator for
// any secondary sort columns. Exposes onClick for keyboard accessibility.
function SortHeader({
  col,
  sortKeys,
  onSort,
  children,
  className,
  tooltip,
}: {
  col: string;
  sortKeys: SortEntry[];
  onSort: (col: string) => void;
  children: ReactNode;
  className?: string;
  tooltip?: string;
}) {
  const idx = sortKeys.findIndex((s) => s.col === col);
  const entry = sortKeys[idx];
  const arrow = entry ? (entry.dir === "asc" ? " ↑" : " ↓") : "";
  const rank = idx > 0 ? ` ${idx + 1}` : "";
  const label = (
    <span className={idx === 0 ? "text-accent" : idx > 0 ? "text-gray-400" : ""}>
      {children}
      {arrow && (
        <span className={`ml-0.5 font-mono text-[10px] ${idx === 0 ? "text-accent" : "text-gray-400"}`}>
          {arrow}
          {rank}
        </span>
      )}
    </span>
  );
  return (
    <th
      className={`cursor-pointer select-none py-2 pr-3 hover:text-accent ${className ?? ""}`}
      onClick={() => onSort(col)}
    >
      {tooltip ? <Tooltip content={tooltip}>{label}</Tooltip> : label}
    </th>
  );
}

// -------------------------------------------------------------------------- //

export function DashboardPage() {
  const qc = useQueryClient();
  // Deploy info is opt-in (it hits the service clients); toggling it re-queries.
  // An optional env scopes the deployed-version lookup (e.g. the stage Jenkins job).
  const [showDeploy, setShowDeploy] = useState(false);
  const [deployEnv, setDeployEnv] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", showDeploy, showDeploy ? deployEnv : ""],
    queryFn: () => fetchDashboard(showDeploy, deployEnv || undefined),
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagName, setTagName] = useState("");
  const [tagRef, setTagRef] = useState("");
  // Tag search across apps (server-side prefix filter).
  const [tagQuery, setTagQuery] = useState("");
  const [tagSearch, setTagSearch] = useState("");
  const tagHits = useQuery({
    queryKey: ["dashboard-tags", tagSearch],
    queryFn: () => searchDashboardTags({ prefix: tagSearch || undefined, limit: 20 }),
    enabled: tagSearch !== "",
  });

  const [sortKeys, setSortKeys] = useState<SortEntry[]>([]);
  const handleSort = (col: string) => setSortKeys((prev) => nextSortKeys(prev, col));

  const rows = data?.rows ?? [];
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => active.test(r) && (!q || r.app.toLowerCase().includes(q)));
    return sortRows(filtered, sortKeys);
  }, [rows, active, search, sortKeys]);

  const tag = useMutation({
    mutationFn: tagApps,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard"] }),
  });

  const toggle = (app: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(app) ? next.delete(app) : next.add(app);
      return next;
    });

  const selectAllVisible = () => setSelected(new Set(visible.filter((r) => r.git?.isRepo).map((r) => r.app)));

  const s = data?.summary;
  const tagResults = tag.data?.results ?? [];

  // Chart over the git facts: the apps whose current branch has diverged most
  // from main (commits ahead/behind the default branch), most-diverged first.
  const divergence = useMemo(() => {
    return rows
      .filter((r) => (r.git?.aheadOfBase ?? 0) > 0 || (r.git?.behindBase ?? 0) > 0)
      .map((r) => ({ app: r.app, ahead: r.git?.aheadOfBase ?? 0, behind: r.git?.behindBase ?? 0 }))
      .sort((a, b) => b.ahead + b.behind - (a.ahead + a.behind))
      .slice(0, 12);
  }, [rows]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeading
        title="Dashboard"
        count={rows.length}
        toolbar={
          <>
            <Tooltip
              multiline
              content="Resolves each app's latest published image (Quay tag, image sha, and source commit, via Jenkins) and adds those columns. It's opt-in because it calls the deploy service clients and needs their credentials."
            >
              <button
                type="button"
                className={showDeploy ? BTN_PRIMARY_CLASS : BTN_GHOST_CLASS}
                onClick={() => setShowDeploy((v) => !v)}
              >
                {showDeploy ? "✓ Deployed versions" : "Deployed versions"}
              </button>
            </Tooltip>
            {showDeploy && (
              <Tooltip
                multiline
                content="Scopes the deployed-version lookup to a specific environment's Jenkins job (e.g. stage). Leave blank to use the default environment."
              >
                <input
                  className={FIELD_CLASS}
                  style={{ maxWidth: 120 }}
                  value={deployEnv}
                  placeholder="env (e.g. stage)"
                  onChange={(e) => setDeployEnv(e.target.value)}
                />
              </Tooltip>
            )}
            <Tooltip
              multiline
              content="Re-runs the git-status scan across all apps and pulls in any changes since the page loaded."
            >
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                onClick={() => qc.invalidateQueries({ queryKey: ["dashboard"] })}
              >
                ↻ Refresh
              </button>
            </Tooltip>
          </>
        }
      />

      {showDeploy && data?.deployConfigured === false && (
        <div className={`${CARD_CLASS} p-3 text-sm text-gray-500`}>
          No deploy service credentials configured. Set <span className="font-mono">QUAY_API_TOKEN</span> /{" "}
          <span className="font-mono">JENKINS_USER</span>+<span className="font-mono">JENKINS_API_TOKEN</span> (and the
          per-app <span className="font-mono">apis</span> entries) in <span className="font-mono">~/.rubato/.env</span>
          <OpenPathButton path="~/.rubato/.env" />, then this will show each app's latest published version + image sha.
        </div>
      )}

      {/* Summary: percent-of-apps bars for the at-a-glance roll-ups. */}
      {s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryStat label="Apps" value={s.total} />
          <SummaryStat label="Git repos" value={s.repos} of={s.total} />
          <SummaryStat label="Clean" value={s.clean} of={s.repos} tone="emerald" />
          <SummaryStat label="Uncommitted" value={s.dirty} of={s.repos} tone="amber" />
          <SummaryStat label="Behind" value={s.behind} of={s.repos} tone="sky" />
          <SummaryStat label="Gone upstreams" value={s.withGoneBranches} of={s.repos} tone="rose" />
        </div>
      )}

      {/* Chart: branch divergence vs main — diverging bars (behind ← | → ahead). */}
      {divergence.length > 0 && (
        <div className={`${CARD_CLASS} flex flex-col gap-2 p-3`}>
          <span className="text-sm font-medium">Branch divergence vs main</span>
          <DivergingBars
            data={divergence.map((d) => ({ label: d.app, left: d.behind, right: d.ahead }))}
            leftLabel="behind"
            rightLabel="ahead"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="filter apps…" />
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1 text-xs transition pointer-coarse:min-h-9 pointer-coarse:text-sm ${
                filter === f.key
                  ? "border-accent bg-accent-soft font-medium text-accent"
                  : "border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tag search: find which apps carry tags matching a name prefix (e.g. "v1"). */}
      <div className={`${CARD_CLASS} flex flex-col gap-2 p-3`}>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTagSearch(tagQuery.trim());
          }}
        >
          <span className="text-sm font-medium">Find tags</span>
          <input
            className={FIELD_CLASS}
            style={{ maxWidth: 220 }}
            value={tagQuery}
            onChange={(e) => setTagQuery(e.target.value)}
            placeholder="tag name prefix (e.g. v1.)"
          />
          <button type="submit" className={BTN_GHOST_CLASS} disabled={tagHits.isFetching}>
            {tagHits.isFetching ? "Searching…" : "Search"}
          </button>
          {tagSearch && (
            <button
              type="button"
              className={BTN_GHOST_CLASS}
              onClick={() => {
                setTagQuery("");
                setTagSearch("");
              }}
            >
              Clear
            </button>
          )}
        </form>
        {tagSearch && !tagHits.isFetching && (
          <div className="flex flex-col gap-1.5 text-sm">
            {(tagHits.data?.results.length ?? 0) === 0 ? (
              <p className="text-gray-500">
                No tags{tagSearch ? ` starting with "${tagSearch}"` : ""}.
              </p>
            ) : (
              tagHits.data?.results.map((r) => (
                <div key={r.app} className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{r.app}</span>
                  <span className="flex flex-wrap gap-1">
                    {r.tags.map((t) => (
                      <Badge key={t.name} tone="neutral">
                        <span className="font-mono">{t.name}</span>
                        <span className="text-gray-400"> · {t.commit}</span>
                      </Badge>
                    ))}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Tag panel: tag a commit on the selected apps (the "tag a subset" flow). */}
      {selected.size > 0 && (
        <div className={`${CARD_CLASS} flex flex-wrap items-end gap-3 p-3`}>
          <span className="text-sm font-medium">{selected.size} selected</span>
          <input
            className={FIELD_CLASS}
            style={{ maxWidth: 180 }}
            value={tagName}
            onChange={(e) => setTagName(e.target.value)}
            placeholder="tag name (e.g. v1.2.3)"
          />
          <input
            className={FIELD_CLASS}
            style={{ maxWidth: 140 }}
            value={tagRef}
            onChange={(e) => setTagRef(e.target.value)}
            placeholder="ref (blank/latest = HEAD)"
          />
          <Tooltip
            multiline
            content="Creates the named git tag on every selected app at once, pointing at the ref you entered (or each app's latest commit if blank). This writes a real tag in each repo."
          >
            <button
              type="button"
              className={BTN_PRIMARY_CLASS}
              disabled={!tagName.trim() || tag.isPending}
              onClick={() => tag.mutate({ apps: [...selected], tag: tagName.trim(), ref: tagRef.trim() || undefined })}
            >
              {tag.isPending ? "Tagging…" : `Tag ${selected.size} app(s)`}
            </button>
          </Tooltip>
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      {tagResults.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {tagResults.map((r) =>
            r.error ? (
              <Tooltip key={r.app} content={r.error}>
                <span className={r.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                  {r.ok ? "✓" : "✗"} {r.app}
                </span>
              </Tooltip>
            ) : (
              <span key={r.app} className={r.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                {r.ok ? "✓" : "✗"} {r.app}
              </span>
            )
          )}
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading app status…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-gray-400">
              <tr className="border-b border-gray-200 dark:border-gray-800">
                <th className="py-2 pr-3">
                  <Tooltip
                    multiline
                    content="Selects every git repo currently visible (after the search and filter), so you can tag them all in one action."
                  >
                    <button type="button" className="hover:text-accent" onClick={selectAllVisible}>
                      ☑
                    </button>
                  </Tooltip>
                </th>
                <SortHeader col="app" sortKeys={sortKeys} onSort={handleSort}>App</SortHeader>
                <SortHeader col="branch" sortKeys={sortKeys} onSort={handleSort}>Branch</SortHeader>
                <SortHeader col="upstream" sortKeys={sortKeys} onSort={handleSort}>±Upstream</SortHeader>
                <SortHeader
                  col="main"
                  sortKeys={sortKeys}
                  onSort={handleSort}
                  tooltip="Commits ahead of / behind the default branch (main/master)"
                >
                  ±Main
                </SortHeader>
                <SortHeader col="dirty" sortKeys={sortKeys} onSort={handleSort}>Dirty</SortHeader>
                <SortHeader col="branches" sortKeys={sortKeys} onSort={handleSort}>Branches</SortHeader>
                <SortHeader col="tags" sortKeys={sortKeys} onSort={handleSort}>Tags</SortHeader>
                {showDeploy && (
                  <>
                    <SortHeader
                      col="version"
                      sortKeys={sortKeys}
                      onSort={handleSort}
                      tooltip="Latest published image version (Quay tag)"
                    >
                      Version
                    </SortHeader>
                    <th className="py-2 pr-3">
                      <Tooltip content="Latest published image digest (short)"><span>Image</span></Tooltip>
                    </th>
                    <th className="py-2 pr-3">
                      <Tooltip content="Git commit the deployed build was built from"><span>Commit</span></Tooltip>
                    </th>
                  </>
                )}
                <th className="py-2 pr-3">Flags</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.app} className="border-b border-gray-100 dark:border-gray-900">
                  <td className="py-1.5 pr-3">
                    {r.git?.isRepo && (
                      <input type="checkbox" checked={selected.has(r.app)} onChange={() => toggle(r.app)} />
                    )}
                  </td>
                  <td className="py-1.5 pr-3 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <Link
                        to={`/apps/${encodeURIComponent(r.app)}`}
                        className="hover:text-accent hover:underline"
                      >
                        {r.app}
                      </Link>
                      <OpenPathButton path={r.path} title={`Open ${r.app} in editor`} />
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-xs">
                    {r.git?.branch ? (
                      r.git.branchCreatedAt ? (
                        <Tooltip content={`branched from ${r.git.defaultBranch ?? "main"} on ${shortDate(r.git.branchCreatedAt)}`}>
                          <span>{r.git.branch}</span>
                        </Tooltip>
                      ) : (
                        <span>{r.git.branch}</span>
                      )
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {r.git?.isRepo ? (
                      <span>
                        {(r.git.ahead ?? 0) > 0 && <span className="text-emerald-600">↑{r.git.ahead}</span>}{" "}
                        {(r.git.behind ?? 0) > 0 && <span className="text-sky-600">↓{r.git.behind}</span>}
                        {(r.git.ahead ?? 0) === 0 && (r.git.behind ?? 0) === 0 && (
                          <span className="text-gray-400">—</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {/* vs the default branch — only meaningful on a feature branch. */}
                    {r.git?.aheadOfBase === undefined && r.git?.behindBase === undefined ? (
                      <span className="text-gray-400">—</span>
                    ) : (
                      <span>
                        {(r.git?.aheadOfBase ?? 0) > 0 && <span className="text-emerald-600">↑{r.git?.aheadOfBase}</span>}{" "}
                        {(r.git?.behindBase ?? 0) > 0 && <span className="text-sky-600">↓{r.git?.behindBase}</span>}
                        {(r.git?.aheadOfBase ?? 0) === 0 && (r.git?.behindBase ?? 0) === 0 && (
                          <span className="text-gray-400">—</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {(r.git?.dirtyCount ?? 0) > 0 ? (
                      <span className="text-amber-600">{r.git?.dirtyCount}</span>
                    ) : (
                      <span className="text-gray-400">0</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-xs text-gray-500">
                    {r.git?.isRepo
                      ? `${r.git.localBranchCount} local · ${r.git.remoteBranchCount} remote`
                      : "—"}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums text-xs">{r.git?.tagCount ?? 0}</td>
                  {showDeploy && (
                    <>
                      <td className="py-1.5 pr-3 font-mono text-xs">
                        {r.deploy?.version ? (
                          <Tooltip content={[
                            r.deploy.publishedAt ? `published ${shortDate(r.deploy.publishedAt)}` : "",
                            r.deploy.buildNumber ? `build #${r.deploy.buildNumber}` : "",
                            r.deploy.env ? `env ${r.deploy.env}` : "",
                          ].filter(Boolean).join(" · ")}>
                            <span>{r.deploy.version}</span>
                          </Tooltip>
                        ) : r.deploy?.error ? (
                          <Tooltip content={r.deploy.error}>
                            <span className="text-amber-600" aria-label={`Warning: ${r.deploy.error}`}>⚠</span>
                          </Tooltip>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs">
                        {r.deploy?.imageSha ? (
                          <Tooltip content={r.deploy.imageDigest ?? r.deploy.imageSha}>
                            <span>{r.deploy.imageSha.slice(0, 10)}</span>
                          </Tooltip>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs">
                        {r.deploy?.commit ? (
                          <Tooltip content="git commit the deployed build was built from">
                            <span>{r.deploy.commit.slice(0, 8)}</span>
                          </Tooltip>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    </>
                  )}
                  <td className="py-1.5 pr-3">
                    <span className="flex flex-wrap gap-1">
                      {(r.git?.localOnlyBranches.length ?? 0) > 0 && <Badge tone="accent">local-only</Badge>}
                      {(r.git?.goneBranches.length ?? 0) > 0 && <Badge tone="error">gone</Badge>}
                      {(r.git?.stashCount ?? 0) > 0 && <Badge tone="neutral">{r.git?.stashCount} stash</Badge>}
                      {r.errors.length > 0 && (
                        <Tooltip content={r.errors.join("; ")}>
                          <span className="text-xs text-rose-500">error</span>
                        </Tooltip>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <p className="mt-3 text-sm text-gray-500">No apps match this filter.</p>}
        </div>
      )}
    </div>
  );
}

// A compact KPI tile with an optional "X of Y" percent bar. The tile itself is
// cwip's shared `StatTile`; this wrapper supplies the rubato card chrome and maps
// the semantic `tone` onto the bar's Tailwind color.
const TONE_BAR_CLASS: Record<"accent" | "emerald" | "amber" | "sky" | "rose", string> = {
  accent: "bg-accent",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  sky: "bg-sky-500",
  rose: "bg-rose-500",
};

function SummaryStat({
  label,
  value,
  of,
  tone = "accent",
}: {
  label: string;
  value: number;
  of?: number;
  tone?: "accent" | "emerald" | "amber" | "sky" | "rose";
}) {
  return (
    <div className={`${CARD_CLASS} p-3`}>
      <StatTile
        label={label}
        value={value}
        progress={
          of && of > 0 ? { value, max: of, barClassName: TONE_BAR_CLASS[tone], label: "of repos" } : undefined
        }
      />
    </div>
  );
}
