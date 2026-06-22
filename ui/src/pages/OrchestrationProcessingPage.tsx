import { type BarDatum, CategoryBars, CategoryDonut, ChartThemeProvider, chartThemeFor, type DonutSlice, formatMs, TimeSeriesChart } from 'cursedbelt/react/charts';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CATEGORY_GROUP_LABELS, colorForCategory } from "cwip/orchestration";
import { DisclosureButton, StatTile } from "cursedbelt/react";
import { useMemo, useState } from "react";
import {
  clearTimings,
  fetchTimings,
  ingestTimings,
  type OrchCategoryStat,
  type OrchTimingRow,
  type TimingOverview,
  type TimingQueryParams,
} from "../api";
import {
  Alert,
  Badge,
  BTN_DANGER_CLASS,
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  FIELD_CLASS,
  OpenPathButton,
  PageHeading,
  Tabs,
  Tooltip,
} from "../components";
import { useConfirm } from "../confirm";
import { getTheme } from "../theme";
import { useToast } from "../toast";

/**
 * Orchestration Processing — per-category timing analytics for the agent
 * task-runner work, kept SEPARATE from the Orchestration dashboard so it doesn't
 * clutter the Watchdog/Tasks/Runs view.
 *
 * It ingests the orchlog recorder's `timing-*.jsonl` files into SQLite (so the JSONL
 * can be deleted later while the analytics persist) and renders KPIs + charts + a
 * sortable per-category table over the stored rows. The aggregation math is
 * cwip/orchestration's (`aggregateByCategory`/`summarize`) — the single source of
 * truth; this page is just the presentation. Filters (date range + repo) and data
 * management (sync / clear-all / clear-before) drive the same server endpoints.
 */

const QK = ["orchestration", "timings"] as const;

type View = "chart" | "table";
const VIEWS: readonly { key: View; label: string }[] = [
  { key: "chart", label: "Charts" },
  { key: "table", label: "Table" },
];

/** A bar-metric the CategoryBars chart can show. */
type BarMetric = "avgMs" | "maxMs" | "totalMs";
const BAR_METRICS: readonly { key: BarMetric; label: string }[] = [
  { key: "avgMs", label: "Average" },
  { key: "maxMs", label: "Longest" },
  { key: "totalMs", label: "Total" },
];

/** Sortable columns for the per-category table (the user wants all of these). */
type SortKey = "label" | "count" | "minMs" | "maxMs" | "avgMs" | "medianMs" | "totalMs";

/** A local YYYY-MM-DD date input → epoch ms (start of that day, local). null when blank. */
function dateToEpoch(value: string, endOfDay = false): number | undefined {
  if (!value) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  const dt = new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return dt.getTime();
}

const REPO_OPTIONS = ["all", "cursedalchemy", "rubato", "cwip"];

/** vscode://file/<abs> deep link — opens the path in the editor (same scheme ru uses). */
const editorLink = (abs: string) => `vscode://file/${abs}`;

export function OrchestrationProcessingPage({ embedded }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const isDark = getTheme() === "dark";

  const [view, setView] = useState<View>("chart");
  const [barMetric, setBarMetric] = useState<BarMetric>("avgMs");
  const [donutBy, setDonutBy] = useState<"category" | "group">("category");
  const [sortKey, setSortKey] = useState<SortKey>("totalMs");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Filters.
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [repo, setRepo] = useState("all");
  const [clearBeforeDate, setClearBeforeDate] = useState("");

  const params: TimingQueryParams = useMemo(
    () => ({ from: dateToEpoch(fromDate), to: dateToEpoch(toDate, true), repo: repo === "all" ? undefined : repo }),
    [fromDate, toDate, repo],
  );

  // Auto-ingest once on first load (idempotent), then load the snapshot. The manual
  // Sync button re-runs the ingest on demand.
  const ingestOnLoad = useQuery({
    queryKey: ["orchestration", "timings", "auto-ingest"],
    queryFn: ingestTimings,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: [...QK, params],
    queryFn: () => fetchTimings(params),
    // Hold off the first load until the auto-ingest settles, so a fresh DB shows data.
    enabled: !ingestOnLoad.isPending,
  });

  const refetchAll = () => qc.invalidateQueries({ queryKey: QK });

  const sync = useMutation({
    mutationFn: ingestTimings,
    onSuccess: (r) => {
      notify(`Synced ${r.filesRead} file(s): ${r.inserted} new, ${r.skipped} already stored.`, "success");
      refetchAll();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "Sync failed", "error"),
  });

  const clear = useMutation({
    mutationFn: (before?: number) => clearTimings(before),
    onSuccess: (r) => {
      notify(`Deleted ${r.deleted} timing row(s).`, "success");
      refetchAll();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "Clear failed", "error"),
  });

  const onClearAll = async () => {
    if (await confirm({ prompt: "Delete ALL stored timing data? This can't be undone.", confirmText: "Delete all" }))
      clear.mutate(undefined);
  };
  const onClearBefore = async () => {
    const before = dateToEpoch(clearBeforeDate);
    if (before == null) {
      notify("Pick a date to clear before.", "warning");
      return;
    }
    if (
      await confirm({
        prompt: `Delete all timing data before ${clearBeforeDate}? This can't be undone.`,
        confirmText: "Delete older",
      })
    )
      clear.mutate(before);
  };

  const stats = data?.stats ?? [];
  const summary = data?.summary;
  const busiest = stats[0]; // already sorted by totalMs desc server-side

  const sortedStats = useMemo(() => {
    const arr = [...stats];
    arr.sort((a, b) => {
      const av = sortKey === "label" ? a.label : (a[sortKey] as number);
      const bv = sortKey === "label" ? b.label : (b[sortKey] as number);
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [stats, sortKey, sortDir]);

  const setSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "label" ? "asc" : "desc");
    }
  };

  // Bar chart: one bar per category, colored by the canonical category hue.
  const barData: BarDatum[] = useMemo(
    () => stats.map((s) => ({ label: s.label, value: s[barMetric], color: colorForCategory(s.category) })),
    [stats, barMetric],
  );

  // Donut: share of total time, by category (canonical hues) or rolled up by group.
  const donutData: DonutSlice[] = useMemo(() => {
    if (donutBy === "group") {
      return (summary?.byGroup ?? []).map((g) => ({
        name: CATEGORY_GROUP_LABELS[g.group as keyof typeof CATEGORY_GROUP_LABELS] ?? g.group,
        value: g.totalMs,
      }));
    }
    return stats.map((s) => ({ name: s.label, value: s.totalMs, color: colorForCategory(s.category) }));
  }, [stats, summary, donutBy]);

  const trendData = data?.trend ?? [];

  const filterControls = (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
        From
        <input type="date" className={`w-auto ${FIELD_CLASS}`} value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
      </label>
      <label className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
        To
        <input type="date" className={`w-auto ${FIELD_CLASS}`} value={toDate} onChange={(e) => setToDate(e.target.value)} />
      </label>
      <label className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
        Repo
        <select className={`w-auto ${FIELD_CLASS}`} value={repo} onChange={(e) => setRepo(e.target.value)}>
          {REPO_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
          {(data?.repos ?? [])
            .filter((r) => !REPO_OPTIONS.includes(r))
            .map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
        </select>
      </label>
      {(fromDate || toDate || repo !== "all") && (
        <button
          type="button"
          className={BTN_GHOST_CLASS}
          onClick={() => {
            setFromDate("");
            setToDate("");
            setRepo("all");
          }}
        >
          Reset filters
        </button>
      )}
      <button
        type="button"
        className={BTN_PRIMARY_CLASS}
        onClick={() => sync.mutate()}
        disabled={sync.isPending}
      >
        {sync.isPending ? "Syncing…" : "Sync from files"}
      </button>
    </div>
  );

  return (
    <div className="mx-auto max-w-7xl">
      {embedded ? (
        <div className="mb-4 pt-3">{filterControls}</div>
      ) : (
        <PageHeading
          title="Orchestration Processing"
          actions={
            <button
              type="button"
              className={BTN_PRIMARY_CLASS}
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
            >
              {sync.isPending ? "Syncing…" : "Sync from files"}
            </button>
          }
          toolbar={
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
                From
                <input type="date" className={`w-auto ${FIELD_CLASS}`} value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              </label>
              <label className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
                To
                <input type="date" className={`w-auto ${FIELD_CLASS}`} value={toDate} onChange={(e) => setToDate(e.target.value)} />
              </label>
              <label className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
                Repo
                <select className={`w-auto ${FIELD_CLASS}`} value={repo} onChange={(e) => setRepo(e.target.value)}>
                  {REPO_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                  {(data?.repos ?? [])
                    .filter((r) => !REPO_OPTIONS.includes(r))
                    .map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                </select>
              </label>
              {(fromDate || toDate || repo !== "all") && (
                <button
                  type="button"
                  className={BTN_GHOST_CLASS}
                  onClick={() => {
                    setFromDate("");
                    setToDate("");
                    setRepo("all");
                  }}
                >
                  Reset filters
                </button>
              )}
            </div>
          }
        />
      )}

      {isError && (
        <Alert tone="error" className="mb-4">
          {error instanceof Error ? error.message : "Failed to load timing data."}
        </Alert>
      )}

      {isLoading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading timing analytics…</p>}

      {data && data.total === 0 && (
        <div className={`${CARD_CLASS} p-6 text-center`}>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            No timing data stored yet. The orchlog recorder writes{" "}
            <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">timing-*.jsonl</code> files under the runs
            directory; click <strong>Sync from files</strong> to ingest them.
          </p>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Runs dir: <span className="font-mono">{data.runsDir}</span>
          </p>
        </div>
      )}

      {data && data.total > 0 && summary && (
        <ChartThemeProvider theme={chartThemeFor(isDark)}>
          {/* KPIs */}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className={`${CARD_CLASS} p-4`}>
              <StatTile label="Tasks" value={summary.taskCount.toLocaleString()} sub={`${summary.eventCount.toLocaleString()} events`} />
            </div>
            <div className={`${CARD_CLASS} p-4`}>
              <StatTile label="Total tracked time" value={formatMs(summary.totalMs)} />
            </div>
            <div className={`${CARD_CLASS} p-4`}>
              <StatTile
                label="Avg task duration"
                value={formatMs(summary.taskCount ? summary.totalMs / summary.taskCount : 0)}
              />
            </div>
            <div className={`${CARD_CLASS} p-4`}>
              <StatTile
                label="Busiest category"
                value={busiest ? busiest.label : "—"}
                sub={busiest ? `${formatMs(busiest.totalMs)} total` : undefined}
                color={busiest ? colorForCategory(busiest.category) : undefined}
              />
            </div>
          </div>

          <div className="mb-4">
            <Tabs tabs={VIEWS} active={view} onChange={setView} />
          </div>

          {view === "chart" ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* Per-category bars */}
              <div className={`${CARD_CLASS} p-4 lg:col-span-2`}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Duration by category</h3>
                  <div className="flex gap-1">
                    {BAR_METRICS.map((m) => (
                      <button
                        key={m.key}
                        type="button"
                        onClick={() => setBarMetric(m.key)}
                        className={`rounded-md px-2 py-1 text-xs transition-colors ${
                          barMetric === m.key
                            ? "bg-accent text-white"
                            : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                <CategoryBars data={barData} height={280} valueFormatter={formatMs} />
              </div>

              {/* Share-of-time donut */}
              <div className={`${CARD_CLASS} p-4`}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Share of time</h3>
                  <div className="flex gap-1">
                    {(["category", "group"] as const).map((b) => (
                      <button
                        key={b}
                        type="button"
                        onClick={() => setDonutBy(b)}
                        className={`rounded-md px-2 py-1 text-xs capitalize transition-colors ${
                          donutBy === b
                            ? "bg-accent text-white"
                            : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                        }`}
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                </div>
                <CategoryDonut
                  data={donutData}
                  height={280}
                  valueFormatter={formatMs}
                  centerValue={formatMs(summary.totalMs)}
                  centerLabel="total"
                />
              </div>

              {/* Duration trend over time */}
              <div className={`${CARD_CLASS} p-4`}>
                <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">Duration over time</h3>
                <TimeSeriesChart
                  data={trendData}
                  series={[{ key: "totalMs", name: "Work time", kind: "area" }]}
                  height={280}
                  valueFormatter={formatMs}
                  includeDate
                />
              </div>
            </div>
          ) : (
            <CategoryTable stats={sortedStats} sortKey={sortKey} sortDir={sortDir} onSort={setSort} />
          )}

          {/* Recent rows table */}
          <RecentRows rows={data.rows} total={data.total} />

          {/* Sources + data management */}
          <SourcesPanel data={data} />
          <DataManagement
            onClearAll={onClearAll}
            onClearBefore={onClearBefore}
            clearBeforeDate={clearBeforeDate}
            setClearBeforeDate={setClearBeforeDate}
            busy={clear.isPending}
          />
        </ChartThemeProvider>
      )}
    </div>
  );
}

// ── Per-category stats table (sortable: count/min/max/avg/median/total) ───────

function CategoryTable({
  stats,
  sortKey,
  sortDir,
  onSort,
}: {
  stats: OrchCategoryStat[];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
}) {
  const cols: { key: SortKey; label: string; numeric?: boolean }[] = [
    { key: "label", label: "Category" },
    { key: "count", label: "Count", numeric: true },
    { key: "minMs", label: "Shortest", numeric: true },
    { key: "maxMs", label: "Longest", numeric: true },
    { key: "avgMs", label: "Average", numeric: true },
    { key: "medianMs", label: "Median", numeric: true },
    { key: "totalMs", label: "Total", numeric: true },
  ];
  const arrow = (key: SortKey) => (key === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "");
  return (
    <div className={`${CARD_CLASS} overflow-auto`}>
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:text-gray-400">
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={`px-3 py-2 ${c.numeric ? "text-right" : ""}`}>
                <button type="button" className="font-medium hover:text-accent" onClick={() => onSort(c.key)}>
                  {c.label}
                  {arrow(c.key)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.category} className="border-b border-gray-100 last:border-0 dark:border-gray-800/60">
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorForCategory(s.category) }} />
                  {s.label}
                  <Badge tone="neutral">{s.group}</Badge>
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{s.count.toLocaleString()}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMs(s.minMs)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMs(s.maxMs)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMs(s.avgMs)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMs(s.medianMs)}</td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMs(s.totalMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Recent rows (per-event), each deep-linking its source file ────────────────

function RecentRows({ rows, total }: { rows: OrchTimingRow[]; total: number }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return (
    <div className={`mt-4 ${CARD_CLASS}`}>
      <DisclosureButton
        open={open}
        onToggle={() => setOpen((o) => !o)}
        className="px-4 py-3 text-sm font-semibold text-gray-700 dark:text-gray-300"
      >
        <span>
          Recent events <span className="font-normal text-gray-400">({rows.length} shown of {total})</span>
        </span>
      </DisclosureButton>
      {open && (
        <div className="overflow-auto border-t border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Repo</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Task</th>
                <th className="px-3 py-2 text-right">Duration</th>
                <th className="px-3 py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.eventId} className="border-b border-gray-100 last:border-0 dark:border-gray-800/60">
                  <td className="whitespace-nowrap px-3 py-2 text-gray-500 dark:text-gray-400">
                    {r.ts ? new Date(r.ts).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2">{r.repo}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: colorForCategory(r.category) }} />
                      {r.label}
                    </span>
                  </td>
                  <td className="max-w-xs truncate px-3 py-2">
                    <Tooltip content={r.taskTitle ?? r.taskId}>
                      <span>{r.taskTitle || r.taskId}</span>
                    </Tooltip>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMs(r.durationMs)}</td>
                  <td className="px-3 py-2">
                    {r.sourceFile ? (
                      <span className="flex items-center gap-1.5">
                        <Tooltip content={r.sourceFile}>
                          <a href={editorLink(r.sourceFile)} className="text-accent hover:underline">
                            {r.sourceFile.split("/").pop()}
                          </a>
                        </Tooltip>
                        <OpenPathButton path={r.sourceFile} />
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Sources + workspace links ─────────────────────────────────────────────────

function SourcesPanel({ data }: { data: TimingOverview }) {
  const tasksCompleted = `${data.notesDir}/Tasks_Completed.md`;
  return (
    <div className={`mt-4 ${CARD_CLASS} p-4`}>
      <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">Source files</h3>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        Data dir:{" "}
        <a href={editorLink(data.runsDir)} className="font-mono text-accent hover:underline">
          {data.runsDir}
        </a>{" "}
        · <OpenPathButton path={data.runsDir} />
        {" · "}
        <a href={editorLink(tasksCompleted)} className="text-accent hover:underline">
          Tasks_Completed.md
        </a>
      </p>
      {data.sources.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No source files recorded.</p>
      ) : (
        <ul className="divide-y divide-gray-100 text-sm dark:divide-gray-800/60">
          {data.sources.map((s) => (
            <li key={s.file} className="flex items-center justify-between gap-3 py-1.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <Tooltip content={s.file}>
                  <a href={editorLink(s.file)} className="truncate text-accent hover:underline">
                    {s.file.split("/").pop()}
                  </a>
                </Tooltip>
                <OpenPathButton path={s.file} />
              </span>
              <Badge tone="neutral">{s.count} events</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Data management (delete old data anytime) ─────────────────────────────────

function DataManagement({
  onClearAll,
  onClearBefore,
  clearBeforeDate,
  setClearBeforeDate,
  busy,
}: {
  onClearAll: () => void;
  onClearBefore: () => void;
  clearBeforeDate: string;
  setClearBeforeDate: (v: string) => void;
  busy: boolean;
}) {
  return (
    <div className={`mt-4 ${CARD_CLASS} p-4`}>
      <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">Data management</h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          Clear before
          <input
            type="date"
            className={`w-auto ${FIELD_CLASS}`}
            value={clearBeforeDate}
            onChange={(e) => setClearBeforeDate(e.target.value)}
          />
        </label>
        <button type="button" className={BTN_GHOST_CLASS} onClick={onClearBefore} disabled={busy}>
          Clear older data
        </button>
        <button type="button" className={BTN_DANGER_CLASS} onClick={onClearAll} disabled={busy}>
          Clear all data
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Clearing only removes the stored analytics rows — re-sync from the JSONL files to repopulate (until you delete
        those too).
      </p>
    </div>
  );
}
