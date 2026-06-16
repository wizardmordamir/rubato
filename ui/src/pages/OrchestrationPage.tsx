import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { colorForCategory } from "cwip/orchestration";
import {
  CategoryBars,
  CategoryDonut,
  ChartThemeProvider,
  chartThemeFor,
  type BarDatum,
  type DonutSlice,
  formatMs,
  StatTile,
} from "cwip/react";
import { formatDuration, formatTokens, formatUsd, WORKFLOW_STATUS_LABELS } from "@shared/orchestration";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
  fetchClaudeUsage,
  fetchEntryTimings,
  fetchOrchestration,
  fetchOrchestrationFile,
  fetchOrchestrationFiles,
  fetchTimings,
  ingestTimings,
  saveOrchestrationFile,
  type ClaudeRateLimitInfo,
  type HistoryEntry,
  type OrchCategoryStat,
  type OrchestrationFileDoc,
  type OrchestrationOverview,
  type RunEntry,
  type RunStatus,
  type WorkflowTask,
  type WorkflowTaskStatus,
} from "../api";
import {
  Alert,
  Badge,
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  FIELD_CLASS,
  OpenPathButton,
  PageHeading,
  Spinner,
  Tabs,
  Tooltip,
} from "../components";
import { IconList, IconMaximize, IconMinimize } from "../icons";
import { usePersistentBoolean } from "../persisted";
import { getTheme } from "../theme";
import { useToast } from "../toast";
import { WatchdogView } from "./WatchdogView";

/**
 * The Orchestration area — configure, track, and manage the unattended
 * "drain the task queue" workflows (a headless `claude -p` loop draining
 * TASKS.md). Six tabs:
 *  - Watchdog: start/stop/pace the drainer + its launchd watchdog, with live
 *    in-progress instances, problems, tunable knobs, logs, files, commands
 *  - Tasks: the live TASKS.md board grouped by status (ready/claimed/done/…)
 *  - History: completed-task archive (Tasks_Completed.md) + aggregate stats
 *  - Runs: live status of the runs/*.jsonl headless-run logs
 *  - Files: view + EDIT the workflow config/doc files (server allowlist)
 *  - Usage: live Claude API rate-limit probe + burn-rate analytics from run history
 *
 * The pure parsing/aggregation lives in `rubato/orchestration`; the file reads
 * (and the allowlisted read/write + watchdog control) live in the server.
 */

type Tab = "watchdog" | "tasks" | "history" | "runs" | "files" | "usage";

const TABS: readonly { key: Tab; label: string }[] = [
  { key: "watchdog", label: "Watchdog" },
  { key: "tasks", label: "Tasks" },
  { key: "history", label: "History & stats" },
  { key: "runs", label: "Runs" },
  { key: "files", label: "Files" },
  { key: "usage", label: "Claude Usage" },
];

const STATUS_TONE: Record<WorkflowTaskStatus, "neutral" | "accent" | "success" | "error"> = {
  ready: "accent",
  claimed: "neutral",
  done: "success",
  blocked: "error",
  "not-ready": "neutral",
};
// Order the board sections present them most-actionable first.
const STATUS_ORDER: WorkflowTaskStatus[] = ["ready", "claimed", "blocked", "not-ready", "done"];

export function OrchestrationPage() {
  const [tab, setTab] = useState<Tab>("watchdog");
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["orchestration"],
    queryFn: fetchOrchestration,
    // Auto-refresh while a run is appending so the board/runs feel live.
    refetchInterval: (q) => (q.state.data?.runs.live ? 5000 : false),
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeading
        title="Orchestration"
        actions={
          <Tooltip multiline content="Re-fetch the orchestration overview (Tasks board, History, Runs). The Watchdog tab has its own auto-refresh every 4 seconds; this button manually updates whichever other tab you're viewing.">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className={BTN_GHOST_CLASS}
            >
              {isFetching && <Spinner />}
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </Tooltip>
        }
      />
      <p className="mb-3 text-xs text-gray-500">
        Configure, track &amp; manage the unattended task-queue workflows — the headless{" "}
        <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">claude -p</code> loop that drains{" "}
        <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">TASKS.md</code>.
        {data && (
          <>
            {" "}
            Reading{" "}
            <span className="font-mono">{data.notesDir}</span>
            <OpenPathButton path={data.notesDir} />
            {!data.notesDirExists && (
              <span className="ml-1 text-amber-600 dark:text-amber-400">
                — directory not found; set <code>orchestration.notesDir</code> in config or{" "}
                <code>RUBATO_NOTES_DIR</code>.
              </span>
            )}
          </>
        )}
      </p>

      <Tabs<Tab> tabs={TABS} active={tab} onChange={setTab} />

      {/* The Files tab is a full-height editor (its own panes scroll internally),
          so it fills the column instead of being a scroll container. The other
          tabs are top-to-bottom lists that scroll as a whole. */}
      <div className={`min-h-0 flex-1 ${tab === "files" ? "flex flex-col" : "overflow-auto"}`}>
        {/* Usage and Watchdog tabs render independently (own queries, don't need the
            overview to load first). The rest wait for the overview load below. */}
        {tab === "watchdog" ? (
          <WatchdogView />
        ) : tab === "usage" ? (
          <ClaudeUsageView overviewData={data} />
        ) : isLoading ? (
          <p className="text-gray-400">loading…</p>
        ) : isError ? (
          <Alert tone="error">
            Failed to load: {error instanceof Error ? error.message : "unknown error"}
          </Alert>
        ) : data ? (
          <>
            {tab === "tasks" && <TasksView data={data} />}
            {tab === "history" && <HistoryView data={data} />}
            {tab === "runs" && <RunsView status={data.runs} />}
            {tab === "files" && <FilesView />}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

function TasksView({ data }: { data: OrchestrationOverview }) {
  const { board } = data;
  if (board.total === 0) {
    return <p className="text-gray-400">No tasks parsed from TASKS.md.</p>;
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {STATUS_ORDER.map((s) => (
          <Badge key={s} tone={STATUS_TONE[s]}>
            {WORKFLOW_STATUS_LABELS[s]}: {board.counts[s]}
          </Badge>
        ))}
        <Badge tone="neutral">Total: {board.total}</Badge>
      </div>
      {STATUS_ORDER.filter((s) => board.groups[s].length > 0).map((s) => (
        <section key={s}>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            {WORKFLOW_STATUS_LABELS[s]}
            <span className="text-gray-400">({board.groups[s].length})</span>
          </h3>
          <div className="space-y-2">
            {board.groups[s].map((t, i) => (
              <TaskCard key={`${s}-${i}`} task={t} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TaskCard({ task }: { task: WorkflowTask }) {
  const { meta } = task;
  const [open, setOpen] = useState(false);
  return (
    <div className={`${CARD_CLASS} p-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{task.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
            {meta.worktree && <span>worktree: <span className="font-mono">{meta.worktree}</span></span>}
            {meta.resume && <Badge tone="neutral">resumed</Badge>}
            {meta.repo && <span>repo: <span className="font-mono">{meta.repo}</span></span>}
            {meta.commit && <span>commit: <span className="font-mono">{meta.commit}</span></span>}
            {meta.duration && <span>duration: {meta.duration}</span>}
            {meta.start && <Tooltip content={meta.start}><span>started {fmtTime(meta.start)}</span></Tooltip>}
            {meta.end && <Tooltip content={meta.end}><span>ended {fmtTime(meta.end)}</span></Tooltip>}
            {meta.reason && <span className="text-red-600 dark:text-red-400">blocked: {meta.reason}</span>}
          </div>
        </div>
        <Badge tone={STATUS_TONE[task.status]}>{WORKFLOW_STATUS_LABELS[task.status]}</Badge>
      </div>
      {task.body && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-2 text-xs text-accent hover:underline"
        >
          {open ? "Hide details" : "Show details"}
        </button>
      )}
      {open && task.body && (
        <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-950 dark:text-gray-300">
          {task.body}
        </pre>
      )}
    </div>
  );
}

// ── History + stats ─────────────────────────────────────────────────────────

function HistoryView({ data }: { data: OrchestrationOverview }) {
  const { history, stats } = data;
  const isDark = getTheme() === "dark";

  // Auto-ingest timing data once (idempotent) — shared queryKey with Processing page.
  const autoIngest = useQuery({
    queryKey: ["orchestration", "timings", "auto-ingest"],
    queryFn: ingestTimings,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  // Overall per-category stats (unfiltered — all time, all repos).
  const { data: timingData } = useQuery({
    queryKey: ["orchestration", "timings", {}],
    queryFn: () => fetchTimings({}),
    enabled: !autoIngest.isPending,
    staleTime: 60_000,
  });

  const categoryStats = timingData?.stats ?? [];
  const summary = timingData?.summary;
  const busiest = categoryStats[0];

  const barData: BarDatum[] = useMemo(
    () => categoryStats.map((s) => ({ label: s.label, value: s.totalMs, color: colorForCategory(s.category) })),
    [categoryStats],
  );

  const donutData: DonutSlice[] = useMemo(
    () => categoryStats.map((s) => ({ name: s.label, value: s.totalMs, color: colorForCategory(s.category) })),
    [categoryStats],
  );

  return (
    <div className="space-y-6">
      {/* Task + run KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Tasks done" value={String(stats.totalTasks)} />
        <Stat label="Total time" value={formatDuration(stats.totalDurationSeconds)} />
        <Stat label="Avg / task" value={formatDuration(stats.avgDurationSeconds)} />
        <Stat label="Headless runs" value={String(stats.totalRuns)} />
        <Stat label="Total tokens" value={formatTokens(stats.totalTokens)} />
        <Stat label="Total cost" value={formatUsd(stats.totalCostUsd)} />
      </div>

      {/* Per-repo breakdown */}
      {stats.byRepo.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">By repo</h3>
          <div className={`${CARD_CLASS} overflow-hidden`}>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-gray-950">
                <tr>
                  <th className="px-3 py-2">Repo</th>
                  <th className="px-3 py-2 text-right">Tasks</th>
                  <th className="px-3 py-2 text-right">Time</th>
                </tr>
              </thead>
              <tbody>
                {stats.byRepo.map((r) => (
                  <tr key={r.repo} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-3 py-2 font-mono">{r.repo}</td>
                    <td className="px-3 py-2 text-right">{r.tasks}</td>
                    <td className="px-3 py-2 text-right">{formatDuration(r.durationSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Per-category timing analytics (from the timings DB) */}
      {categoryStats.length > 0 && summary && (
        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Category timing</h3>
          <ChartThemeProvider theme={chartThemeFor(isDark)}>
            {/* KPI tiles */}
            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className={`${CARD_CLASS} p-4`}>
                <StatTile label="Tasks tracked" value={summary.taskCount} sub={`${summary.eventCount} events`} />
              </div>
              <div className={`${CARD_CLASS} p-4`}>
                <StatTile label="Total tracked time" value={formatMs(summary.totalMs)} />
              </div>
              <div className={`${CARD_CLASS} p-4`}>
                <StatTile
                  label="Avg per task"
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

            {/* Charts side-by-side */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className={`${CARD_CLASS} p-4 lg:col-span-2`}>
                <h4 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">Duration by category</h4>
                <CategoryBars data={barData} height={220} valueFormatter={formatMs} />
              </div>
              <div className={`${CARD_CLASS} p-4`}>
                <h4 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">Share of time</h4>
                <CategoryDonut
                  data={donutData}
                  height={220}
                  valueFormatter={formatMs}
                  centerValue={formatMs(summary.totalMs)}
                  centerLabel="total"
                />
              </div>
              {/* Per-category % table */}
              <div className={`${CARD_CLASS} overflow-hidden`}>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-gray-950">
                    <tr>
                      <th className="px-3 py-2">Category</th>
                      <th className="px-3 py-2 text-right">Count</th>
                      <th className="px-3 py-2 text-right">Total</th>
                      <th className="px-3 py-2 text-right">Avg</th>
                      <th className="px-3 py-2 text-right">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryStats.map((s) => (
                      <tr key={s.category} className="border-t border-gray-100 dark:border-gray-800">
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-2">
                            <span
                              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: colorForCategory(s.category) }}
                            />
                            {s.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-500">{s.count}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMs(s.totalMs)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-500">{formatMs(s.avgMs)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-400">
                          {summary.totalMs > 0 ? `${Math.round((s.totalMs / summary.totalMs) * 100)}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </ChartThemeProvider>
        </section>
      )}

      {/* History list */}
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          History <span className="text-gray-400">({history.length})</span>
        </h3>
        {history.length === 0 ? (
          <p className="text-gray-400">No completed tasks parsed from Tasks_Completed.md.</p>
        ) : (
          <div className="space-y-2">
            {history.map((h, i) => (
              <HistoryCard key={`${h.line}-${i}`} entry={h} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const REPO_BADGE_TONE: Record<string, "accent" | "success" | "neutral"> = {
  rubato: "accent",
  cursedalchemy: "success",
  cwip: "neutral",
};

function HistoryCard({ entry }: { entry: HistoryEntry }) {
  const [open, setOpen] = useState(false);
  const isDark = getTheme() === "dark";
  const canExpand = !!(entry.start && entry.end);

  const { data: entryStats, isLoading: statsLoading } = useQuery({
    queryKey: ["orchestration", "timings", "entry", entry.start, entry.end, entry.repo],
    queryFn: () => fetchEntryTimings(entry.start!, entry.end!, entry.repo),
    enabled: open && canExpand,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const entryBarData: BarDatum[] = useMemo(
    () => (entryStats ?? []).map((s) => ({ label: s.label, value: s.totalMs, color: colorForCategory(s.category) })),
    [entryStats],
  );

  const entryTotal = useMemo(() => (entryStats ?? []).reduce((acc, s) => acc + s.totalMs, 0), [entryStats]);

  return (
    <div className={`${CARD_CLASS} p-4`}>
      {/* Card header */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug">{entry.title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {entry.repo && (
              <Badge tone={REPO_BADGE_TONE[entry.repo] ?? "neutral"}>{entry.repo}</Badge>
            )}
            {entry.commit && (
              <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                {entry.commit}
              </span>
            )}
            {entry.durationText && (
              <Badge tone="neutral">{entry.durationText}</Badge>
            )}
            {entry.start && (
              <Tooltip content={entry.start}>
                <span className="text-gray-400">{fmtDate(entry.start)}</span>
              </Tooltip>
            )}
            {entry.end && (
              <Tooltip content={entry.end}>
                <span className="text-gray-400">→ {fmtDate(entry.end)}</span>
              </Tooltip>
            )}
          </div>
        </div>
        {canExpand && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-accent hover:bg-accent-soft transition-colors"
          >
            {open ? "Hide timing" : "Show timing"}
          </button>
        )}
      </div>

      {/* Per-entry category breakdown (lazy) */}
      {open && (
        <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          {statsLoading ? (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Spinner />
              Loading timing breakdown…
            </div>
          ) : entryStats && entryStats.length > 0 ? (
            <ChartThemeProvider theme={chartThemeFor(isDark)}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs font-medium text-gray-500">Time by category</p>
                  <CategoryBars data={entryBarData} height={140} valueFormatter={formatMs} />
                </div>
                <div className="overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="text-left text-gray-400">
                      <tr>
                        <th className="pb-1 pr-3">Category</th>
                        <th className="pb-1 pr-3 text-right">Count</th>
                        <th className="pb-1 pr-3 text-right">Time</th>
                        <th className="pb-1 text-right">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entryStats.map((s) => (
                        <tr key={s.category} className="border-t border-gray-50 dark:border-gray-800/60">
                          <td className="py-1 pr-3">
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="inline-block h-2 w-2 shrink-0 rounded-full"
                                style={{ backgroundColor: colorForCategory(s.category) }}
                              />
                              {s.label}
                            </span>
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums text-gray-500">{s.count}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">{formatMs(s.totalMs)}</td>
                          <td className="py-1 text-right tabular-nums text-gray-400">
                            {entryTotal > 0 ? `${Math.round((s.totalMs / entryTotal) * 100)}%` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </ChartThemeProvider>
          ) : (
            <p className="text-xs text-gray-400">No timing recorded for this task.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Runs ──────────────────────────────────────────────────────────────────────

function RunsView({ status }: { status: RunStatus }) {
  if (!status.hasRuns) {
    return (
      <div className="space-y-2 text-sm text-gray-500">
        <p>No headless-run logs yet.</p>
        <p className="text-xs">
          The queue drainer writes one JSON line per run to{" "}
          <span className="font-mono">orchestration/runs/&lt;timestamp&gt;.jsonl</span>; they'll appear here once a run
          starts.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {status.live ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
            Live — a run is appending
          </span>
        ) : (
          <span className="text-gray-500">Idle</span>
        )}
        <span className="text-gray-400">·</span>
        <span className="text-gray-500">{status.totalRuns} run(s)</span>
        {status.latestFile && (
          <>
            <span className="text-gray-400">·</span>
            <span className="text-gray-500">
              latest <span className="font-mono">{status.latestFile}</span>
              {status.latestModified && <> @ {fmtTime(status.latestModified)}</>}
            </span>
          </>
        )}
      </div>

      <div className="space-y-2">
        {status.recent.map((r, i) => (
          <RunRow key={`${r.sessionId ?? "run"}-${i}`} run={r} />
        ))}
      </div>
    </div>
  );
}

function RunRow({ run }: { run: RunEntry }) {
  return (
    <div className={`${CARD_CLASS} p-3`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
          {run.isError ? <Badge tone="error">error</Badge> : <Badge tone="success">ok</Badge>}
          {run.model && <span className="font-mono">{run.model}</span>}
          {run.sessionId && <span className="font-mono text-gray-400">{run.sessionId.slice(0, 12)}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
          {typeof run.durationMs === "number" && <span>{formatDuration(Math.round(run.durationMs / 1000))}</span>}
          {typeof run.totalTokens === "number" && <span>{formatTokens(run.totalTokens)} tok</span>}
          {typeof run.costUsd === "number" && <span>{formatUsd(run.costUsd)}</span>}
        </div>
      </div>
      {run.result && <p className="mt-1.5 line-clamp-3 text-sm text-gray-600 dark:text-gray-300">{run.result}</p>}
    </div>
  );
}

// ── Files (view + edit) ───────────────────────────────────────────────────────

function FilesView() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const { data: files = [] } = useQuery({ queryKey: ["orchestration-files"], queryFn: fetchOrchestrationFiles });
  const [selected, setSelected] = useState<string | null>(null);

  const key = selected ?? files[0]?.key ?? null;
  const { data: doc, isLoading } = useQuery({
    queryKey: ["orchestration-file", key],
    queryFn: () => fetchOrchestrationFile(key as string),
    enabled: key !== null,
  });

  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  // Let the (long) files be read at full width by tucking the file list away —
  // sticky across reloads, like the other run-option toggles.
  const [listCollapsed, setListCollapsed] = usePersistentBoolean("rubato.orchestration.filesListCollapsed", false);
  // Full-screen reading mode: break out of the page's narrow, padded column
  // (max-w-4xl + heading/tabs) into a viewport-filling overlay, so a long file
  // is read at full width AND all the way to the bottom of the screen. Sticky
  // like the other toggles; Escape (below) leaves it.
  const [fullscreen, setFullscreen] = usePersistentBoolean("rubato.orchestration.filesFullscreen", false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, setFullscreen]);
  useEffect(() => {
    if (doc) setDraft(doc.content);
  }, [doc]);
  useEffect(() => {
    if (doc && !doc.markdown) setPreview(false);
  }, [doc]);

  const save = useMutation({
    mutationFn: (content: string) => saveOrchestrationFile(key as string, content),
    onSuccess: (saved: OrchestrationFileDoc) => {
      notify("Saved", "success");
      qc.setQueryData(["orchestration-file", saved.key], saved);
      qc.invalidateQueries({ queryKey: ["orchestration-files"] });
      // The board/history/runs may have changed (e.g. editing TASKS.md).
      qc.invalidateQueries({ queryKey: ["orchestration"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const dirty = doc !== undefined && draft !== doc.content;

  const saveBtn = (
    <Tooltip
      multiline
      content="Writes your edits straight to this file on disk at its real path (e.g. agent instructions, TASKS.md, loop.md). The editable set is a fixed server allowlist; creates the file if it doesn't exist yet."
    >
      <button
        type="button"
        onClick={() => save.mutate(draft)}
        disabled={!dirty || save.isPending}
        className={BTN_PRIMARY_CLASS}
      >
        {save.isPending && <Spinner />}
        {save.isPending ? "Saving…" : "Save"}
      </button>
    </Tooltip>
  );

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-gray-50 p-4 dark:bg-gray-950"
          : "flex min-h-0 flex-1 flex-col"
      }
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setListCollapsed(!listCollapsed)}
          className={BTN_GHOST_CLASS}
          aria-pressed={!listCollapsed}
        >
          <IconList size={15} />
          {listCollapsed ? "Show files" : "Hide files"}
        </button>
        <div className="flex items-center gap-2">
          <Tooltip content={fullscreen ? "Leave full screen (Esc)" : "Read this file full screen"}>
            <button
              type="button"
              onClick={() => setFullscreen(!fullscreen)}
              className={BTN_GHOST_CLASS}
              aria-pressed={fullscreen}
            >
              {fullscreen ? <IconMinimize size={15} /> : <IconMaximize size={15} />}
              {fullscreen ? "Exit full screen" : "Full screen"}
            </button>
          </Tooltip>
          {doc?.markdown && (
            <button type="button" onClick={() => setPreview((p) => !p)} className={BTN_GHOST_CLASS}>
              {preview ? "Edit" : "Preview"}
            </button>
          )}
          {saveBtn}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-6">
        {!listCollapsed && (
          <nav className="flex w-52 shrink-0 flex-col gap-1 overflow-auto">
            {files.map((f) => (
              <Tooltip key={f.key} content={f.exists ? f.path : `${f.path} — doesn't exist yet`} className="block">
              <button
                type="button"
                onClick={() => setSelected(f.key)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                  f.key === key
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                }`}
              >
                <span
                  aria-hidden
                  className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                    f.exists ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600"
                  }`}
                />
                <span className="min-w-0 truncate">{f.label}</span>
              </button>
              </Tooltip>
            ))}
          </nav>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {doc && (
            <p className="mb-2 text-xs text-gray-500">
              <span className="font-mono">{doc.path}</span>
              {doc.exists && <OpenPathButton path={doc.path} />}
              {!doc.exists && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">— doesn't exist yet; Save will create it.</span>
              )}
              {dirty && <span className="ml-1 text-accent">• unsaved changes</span>}
            </p>
          )}
          {isLoading ? (
            <p className="text-gray-400">loading…</p>
          ) : preview && doc?.markdown ? (
            <article className="chat-md min-h-0 flex-1 overflow-auto rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
              {draft.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {draft}
                </ReactMarkdown>
              ) : (
                <p className="text-gray-400">Nothing to preview.</p>
              )}
            </article>
          ) : (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              placeholder="(empty)"
              className={`min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed ${FIELD_CLASS}`}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Claude Usage ──────────────────────────────────────────────────────────────

const USAGE_COLORS = {
  used: "#f59e0b",
  remaining: "#10b981",
  low: "#ef4444",
};

function ClaudeUsageView({ overviewData }: { overviewData?: OrchestrationOverview }) {
  const isDark = getTheme() === "dark";

  const { data: usage, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["orchestration", "claude-usage"],
    queryFn: fetchClaudeUsage,
    refetchInterval: 60_000,
    staleTime: 55_000,
  });

  const burnRate = useMemo(() => {
    const runs = (overviewData?.runs.recent ?? []).filter((r) => r.totalTokens != null);
    if (runs.length === 0) return null;
    const withTime = runs.filter((r) => r.at != null) as (RunEntry & { at: string })[];
    const sorted = [...withTime].sort((a, b) => a.at.localeCompare(b.at));
    const avgTokensPerRun = Math.round(runs.reduce((s, r) => s + (r.totalTokens ?? 0), 0) / runs.length);
    let tokensPerMin: number | null = null;
    if (sorted.length >= 2) {
      const spanMs = new Date(sorted[sorted.length - 1].at).getTime() - new Date(sorted[0].at).getTime();
      const spanMin = spanMs / 60_000;
      if (spanMin > 0) {
        tokensPerMin = Math.round(sorted.reduce((s, r) => s + (r.totalTokens ?? 0), 0) / spanMin);
      }
    }
    const barData: BarDatum[] = sorted.map((r, i) => ({
      label: r.at ? fmtTimeShort(r.at) : `run ${i + 1}`,
      value: r.totalTokens ?? 0,
      color: "#6366f1",
    }));
    return { avgTokensPerRun, tokensPerMin, barData, runCount: runs.length };
  }, [overviewData]);

  const rateLimitAnalytics = useMemo(() => {
    if (!usage?.limitTokensPerMinute) return null;
    const limit = usage.limitTokensPerMinute;
    const remaining = usage.remainingTokensPerMinute ?? limit;
    const used = limit - remaining;
    const pctUsed = limit > 0 ? (used / limit) * 100 : 0;
    const pctRemaining = 100 - pctUsed;
    const remainingColor = pctRemaining < 20 ? USAGE_COLORS.low : USAGE_COLORS.remaining;
    const donutData: DonutSlice[] = [
      { name: "Remaining", value: remaining, color: remainingColor },
      { name: "Used", value: Math.max(0, used), color: USAGE_COLORS.used },
    ];
    let minsUntilLimit: number | null = null;
    if (burnRate?.tokensPerMin && burnRate.tokensPerMin > 0 && remaining > 0) {
      minsUntilLimit = Math.round(remaining / burnRate.tokensPerMin);
    }
    let resetsIn: string | null = null;
    if (usage.resetTokensAt) {
      const ms = new Date(usage.resetTokensAt).getTime() - Date.now();
      if (ms > 0) resetsIn = fmtDeltaMs(ms);
    }
    return { limit, remaining, used, pctUsed, donutData, minsUntilLimit, resetsIn };
  }, [usage, burnRate]);

  const reqAnalytics = useMemo(() => {
    if (!usage?.limitRequestsPerMinute) return null;
    const limit = usage.limitRequestsPerMinute;
    const remaining = usage.remainingRequestsPerMinute ?? limit;
    const used = limit - remaining;
    return { limit, remaining, used, pctUsed: limit > 0 ? (used / limit) * 100 : 0 };
  }, [usage]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {usage?.fetchedAt && (
            <span>
              Rate-limit snapshot:{" "}
              <Tooltip content={usage.fetchedAt}>
                <span>{fmtTime(usage.fetchedAt)}</span>
              </Tooltip>
            </span>
          )}
          <button type="button" onClick={() => refetch()} disabled={isFetching} className={BTN_GHOST_CLASS}>
            {isFetching && <Spinner />}
            {isFetching ? "Probing…" : "Re-probe"}
          </button>
        </div>
        <a href="https://console.anthropic.com/settings/limits" target="_blank" rel="noreferrer" className={`${BTN_GHOST_CLASS} text-xs`}>
          Anthropic Console ↗
        </a>
      </div>

      {isLoading && <p className="text-sm text-gray-400">Probing Anthropic API…</p>}
      {isError && (
        <Alert tone="error">
          Rate-limit probe failed: {error instanceof Error ? error.message : "unknown error"}
        </Alert>
      )}

      {usage && (
        <>
          {!usage.hasApiKey && (
            <Alert tone="neutral">
              <strong>ANTHROPIC_API_KEY not set</strong> — the rubato server can't probe live rate limits.
              Set the env var when starting rubato to enable this feature.
              History-based burn-rate analytics below are still available.
            </Alert>
          )}
          {usage.hasApiKey && usage.error && (
            <Alert tone="error">API probe error: {usage.error}. Rate-limit values may be stale or unavailable.</Alert>
          )}

          {rateLimitAnalytics && (
            <section>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
                Per-minute rate limits (current window)
              </h3>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className={`${CARD_CLASS} p-4 lg:col-span-1`}>
                  <h4 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">Token window</h4>
                  <ChartThemeProvider theme={chartThemeFor(isDark)}>
                    <CategoryDonut
                      data={rateLimitAnalytics.donutData}
                      height={180}
                      valueFormatter={(v) => formatTokens(v)}
                      centerValue={`${Math.round(100 - rateLimitAnalytics.pctUsed)}%`}
                      centerLabel="remaining"
                    />
                  </ChartThemeProvider>
                </div>
                <div className="lg:col-span-2 grid grid-cols-2 gap-3 content-start">
                  <div className={`${CARD_CLASS} p-4`}>
                    <StatTile label="Token limit / min" value={formatTokens(rateLimitAnalytics.limit)} />
                  </div>
                  <div className={`${CARD_CLASS} p-4`}>
                    <StatTile
                      label="Tokens remaining"
                      value={formatTokens(rateLimitAnalytics.remaining)}
                      sub={`${Math.round(100 - rateLimitAnalytics.pctUsed)}% of window`}
                      color={rateLimitAnalytics.pctUsed > 80 ? USAGE_COLORS.low : USAGE_COLORS.remaining}
                    />
                  </div>
                  <div className={`${CARD_CLASS} p-4`}>
                    <StatTile label="Tokens used this min" value={formatTokens(rateLimitAnalytics.used)} color={USAGE_COLORS.used} />
                  </div>
                  <div className={`${CARD_CLASS} p-4`}>
                    <StatTile
                      label="Window resets in"
                      value={rateLimitAnalytics.resetsIn ?? "—"}
                      sub={usage.resetTokensAt ? fmtTime(usage.resetTokensAt) : undefined}
                    />
                  </div>
                  {reqAnalytics && (
                    <>
                      <div className={`${CARD_CLASS} p-4`}>
                        <StatTile label="Requests / min limit" value={String(reqAnalytics.limit)} />
                      </div>
                      <div className={`${CARD_CLASS} p-4`}>
                        <StatTile
                          label="Requests remaining"
                          value={String(reqAnalytics.remaining)}
                          sub={`${Math.round(100 - reqAnalytics.pctUsed)}% of window`}
                          color={reqAnalytics.pctUsed > 80 ? USAGE_COLORS.low : USAGE_COLORS.remaining}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            </section>
          )}

          {usage.hasApiKey && !usage.error && !rateLimitAnalytics && (
            <div className={`${CARD_CLASS} p-4 text-sm text-gray-500`}>
              Rate-limit headers were not returned by the API probe. The limits may be returned
              on inference calls only. Try re-probing or check the Anthropic Console.
            </div>
          )}
        </>
      )}

      {overviewData && (
        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Burn-rate analytics (from run history)
          </h3>
          {!burnRate ? (
            <div className={`${CARD_CLASS} p-4 text-sm text-gray-500`}>
              No run-log token data available yet. Run the drainer a few times and the charts will populate here.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className={`${CARD_CLASS} p-4`}>
                  <StatTile label="Avg tokens / run" value={formatTokens(burnRate.avgTokensPerRun)} />
                </div>
                <div className={`${CARD_CLASS} p-4`}>
                  <StatTile
                    label="Est. tokens / min"
                    value={burnRate.tokensPerMin != null ? formatTokens(burnRate.tokensPerMin) : "—"}
                    sub="across recorded runs"
                  />
                </div>
                <div className={`${CARD_CLASS} p-4`}>
                  <StatTile label="All-time tokens" value={formatTokens(overviewData.stats.totalTokens)} />
                </div>
                <div className={`${CARD_CLASS} p-4`}>
                  <StatTile label="All-time cost" value={formatUsd(overviewData.stats.totalCostUsd)} />
                </div>
              </div>

              {rateLimitAnalytics?.minsUntilLimit != null && burnRate.tokensPerMin && burnRate.tokensPerMin > 0 && (
                <div className={`${CARD_CLASS} p-4`}>
                  {rateLimitAnalytics.minsUntilLimit <= 0 ? (
                    <p className="text-sm font-medium text-red-600 dark:text-red-400">
                      Rate limit window is depleted. Requests will be throttled until the window resets
                      {rateLimitAnalytics.resetsIn ? ` in ${rateLimitAnalytics.resetsIn}` : ""}.
                    </p>
                  ) : rateLimitAnalytics.minsUntilLimit < 5 ? (
                    <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                      At the current burn rate ({formatTokens(burnRate.tokensPerMin)}/min), the remaining token window
                      will be exhausted in ~{rateLimitAnalytics.minsUntilLimit} min. The window resets{" "}
                      {rateLimitAnalytics.resetsIn ? `in ${rateLimitAnalytics.resetsIn}` : "soon"}.
                    </p>
                  ) : (
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      At {formatTokens(burnRate.tokensPerMin)}/min, remaining tokens (
                      {formatTokens(rateLimitAnalytics.remaining)}) will last ~{rateLimitAnalytics.minsUntilLimit} min
                      — well past the window reset{rateLimitAnalytics.resetsIn ? ` in ${rateLimitAnalytics.resetsIn}` : ""}.
                    </p>
                  )}
                </div>
              )}

              {burnRate.barData.length > 0 && (
                <div className={`${CARD_CLASS} p-4`}>
                  <h4 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
                    Tokens per run (recent, oldest → newest)
                  </h4>
                  <ChartThemeProvider theme={chartThemeFor(isDark)}>
                    <CategoryBars data={burnRate.barData} height={200} valueFormatter={(v) => formatTokens(v)} />
                  </ChartThemeProvider>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <div className={`${CARD_CLASS} p-4 text-xs text-gray-500 space-y-1`}>
        <p>
          <strong className="text-gray-700 dark:text-gray-300">About these limits:</strong>{" "}
          The rate-limit data above reflects per-minute API limits (rolling window). Daily, monthly, or account-level
          usage caps are not available via the API — view them at{" "}
          <a href="https://console.anthropic.com/settings/limits" target="_blank" rel="noreferrer" className="text-accent underline hover:no-underline">
            console.anthropic.com/settings/limits
          </a>{" "}and{" "}
          <a href="https://console.anthropic.com/usage" target="_blank" rel="noreferrer" className="text-accent underline hover:no-underline">
            console.anthropic.com/usage
          </a>
          .
        </p>
        <p>
          The burn-rate estimate is derived from the run-log files in the orchestration directory. It reflects actual
          Claude Code drainer sessions, not all API usage.
        </p>
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Format an ISO timestamp compactly for the local timezone; pass through on parse failure. */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Format an ISO timestamp for history cards — date + time, no year. */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Very short time label (HH:MM) for chart x-axis labels. */
function fmtTimeShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Format a millisecond delta as "Xh Ym" or "Ym Zs". */
function fmtDeltaMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${CARD_CLASS} p-3`}>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
