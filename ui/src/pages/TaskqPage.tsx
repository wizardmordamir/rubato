import { AreaChart, BarChart, type ChartDatum, formatTimeFull, formatTimeTick } from 'cursedbelt/react/charts';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DisclosureButton, DragHandle, StatTile, useDragReorder } from "cursedbelt/react";
import { ModalShell } from "../components/ModalShell";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import {
  answerTaskqClarification,
  calibrateTaskqBucket,
  probeTaskqCapacity,
  createTaskqTask,
  deleteTaskqTask,
  duplicateTaskqTask,
  enqueueTaskqTemplate,
  fetchTaskqBoard,
  fetchTaskqCapacity,
  fetchTaskqClarifications,
  fetchTaskqDrainer,
  fetchTaskqHistory,
  fetchTaskqSectionPrefs,
  fetchTaskqUsage,
  fetchTaskqUsageLive,
  refreshTaskqUsage,
  moveTaskqTask,
  resumeTaskqDrainer,
  runTaskqDrainer,
  runTaskqHealer,
  type HealerResult,
  setTaskqSectionCollapsed,
  setTaskqStatus,
  stopTaskqDrainer,
  type TaskqBucketState,
  type TaskqCapacity,
  type TaskqCcusageReport,
  type TaskqClaudeTelemetry,
  type TaskqUsageSnapshot,
  TASKQ_AUTHORABLE_STATUSES,
  TASKQ_MODEL_ALIASES,
  TASKQ_STATUS_LABELS,
  TASKQ_STATUSES,
  TASKQ_THINK_LEVELS,
  type TaskqBoard,
  fetchTaskqConfig,
  fetchTaskqDrainRuns,
  fetchTaskqInstances,
  fetchTaskqLogs,
  releaseTaskqInstance,
  saveTaskqConfig,
  setTaskqInterval,
  setTaskqWatchdog,
  type TaskqConfig,
  type TaskqConfigPatch,
  type TaskqDrainRun,
  type TaskqFleetTier,
  type TaskqInstance,
  type TaskqNewTask,
  type TaskqPosition,
  type TaskqStatus,
  type TaskqTaskView,
  updateTaskqTask,
  deriveTaskTitle,
  fetchTaskqSerialGroups,
  bulkSetTaskqSerialGroup,
} from "../api";
import { Alert, Badge, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, PageHeading, Spinner, Tabs, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";
import { ForgePage } from "./ForgePage";
import { OllamaPage } from "./OllamaPage";
import { FindingsLedgerPage } from "./FindingsLedgerPage";
import { OrchestrationProcessingPage } from "./OrchestrationProcessingPage";

type TaskqTab = "board" | "forge" | "ollama" | "workers" | "settings" | "usage" | "processing" | "findings";
const TASKQ_TABS: readonly { key: TaskqTab; label: string }[] = [
  { key: "board", label: "Board" },
  { key: "findings", label: "Findings" },
  { key: "forge", label: "Forge" },
  { key: "ollama", label: "Ollama" },
  { key: "workers", label: "Workers" },
  { key: "settings", label: "Settings" },
  { key: "usage", label: "Usage" },
  { key: "processing", label: "Processing" },
];
const VALID_TABS = new Set<string>([
  "board",
  "findings",
  "forge",
  "ollama",
  "workers",
  "settings",
  "usage",
  "processing",
]);

/**
 * Taskq — the v2 orchestrator board + builder, backed by the SQLite queue
 * (cwip/taskq via /api/taskq). Runs alongside the legacy Orchestration page
 * until cutover. Edits are by stable row id (no fragile heading-anchor), so
 * there's no clobber/conflict surface — the DB is the single writer authority.
 */

/** Statuses where drag-reorder changes claim priority (running/done are not). */
const REORDERABLE = new Set<TaskqStatus>(["draft", "ready", "on_hold", "not_ready", "blocked", "pending_triage"]);

/** Board display order: `claimed` (In Progress) floats above `ready` so active work stays visible without scrolling. */
const BOARD_DISPLAY_ORDER: TaskqStatus[] = [
  'draft',
  'pending_triage',
  'claimed',
  'ready',
  'blocked',
  'on_hold',
  'needs_input',
  'not_ready',
  'failed',
  'done',
];

/** 8 distinct color palettes for serial group color-coding. */
const SERIAL_GROUP_COLORS = [
  { border: "border-sky-400", bg: "bg-sky-100 dark:bg-sky-900/50", text: "text-sky-700 dark:text-sky-300" },
  { border: "border-violet-400", bg: "bg-violet-100 dark:bg-violet-900/50", text: "text-violet-700 dark:text-violet-300" },
  { border: "border-emerald-400", bg: "bg-emerald-100 dark:bg-emerald-900/50", text: "text-emerald-700 dark:text-emerald-300" },
  { border: "border-amber-400", bg: "bg-amber-100 dark:bg-amber-900/50", text: "text-amber-700 dark:text-amber-300" },
  { border: "border-rose-400", bg: "bg-rose-100 dark:bg-rose-900/50", text: "text-rose-700 dark:text-rose-300" },
  { border: "border-cyan-400", bg: "bg-cyan-100 dark:bg-cyan-900/50", text: "text-cyan-700 dark:text-cyan-300" },
  { border: "border-orange-400", bg: "bg-orange-100 dark:bg-orange-900/50", text: "text-orange-700 dark:text-orange-300" },
  { border: "border-indigo-400", bg: "bg-indigo-100 dark:bg-indigo-900/50", text: "text-indigo-700 dark:text-indigo-300" },
] as const;

/** Returns a stable color palette for a serial group name (hash-based). */
function serialGroupColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return SERIAL_GROUP_COLORS[Math.abs(h) % SERIAL_GROUP_COLORS.length];
}

/** Find the single id whose removal makes the two orderings identical (the moved one). */
function findMovedId(oldIds: number[], newIds: number[]): number | null {
  if (oldIds.length !== newIds.length) return null;
  for (const id of oldIds) {
    const o = oldIds.filter((x) => x !== id);
    const n = newIds.filter((x) => x !== id);
    if (o.every((x, i) => x === n[i])) return id;
  }
  return null;
}

const STATUS_TONE: Record<TaskqStatus, "neutral" | "accent" | "success" | "error" | "warn"> = {
  draft: "neutral",
  pending_triage: "warn",
  ready: "accent",
  claimed: "neutral",
  blocked: "warn",
  on_hold: "warn",
  needs_input: "warn",
  not_ready: "neutral",
  failed: "error",
  done: "success",
};

export function TaskqPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["taskq"],
    queryFn: fetchTaskqBoard,
    // Poll while work is in flight so claimed/running status shows live.
    refetchInterval: (q) => (q.state.data?.counts.claimed ? 4000 : 10000),
  });
  const { data: sectionPrefsData } = useQuery({
    queryKey: ["taskq-section-prefs"],
    queryFn: fetchTaskqSectionPrefs,
  });
  const [builder, setBuilder] = useState<{ mode: "create" } | { mode: "edit"; task: TaskqTaskView } | null>(null);
  const [params, setParams] = useSearchParams();
  const rawTab = params.get("tab") ?? "board";
  const tab: TaskqTab = VALID_TABS.has(rawTab) ? (rawTab as TaskqTab) : "board";
  const setTab = (t: TaskqTab) => setParams(t === "board" ? {} : { tab: t }, { replace: true });
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();

  const apply = (board: TaskqBoard) => qc.setQueryData(["taskq"], board);

  const del = useMutation({
    mutationFn: (id: number) => deleteTaskqTask(id),
    onSuccess: (r) => {
      apply(r.board);
      notify("Task deleted", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "delete failed", "error"),
  });
  const status = useMutation({
    mutationFn: (v: { id: number; status: TaskqStatus; note?: string }) => setTaskqStatus(v.id, v.status, v.note),
    onSuccess: (r) => apply(r.board),
    onError: (e) => notify(e instanceof Error ? e.message : "status change failed", "error"),
  });
  const move = useMutation({
    mutationFn: (v: { id: number; position: TaskqPosition }) => moveTaskqTask(v.id, v.position),
    onSuccess: (r) => apply(r.board),
    onError: (e) => {
      notify(e instanceof Error ? e.message : "reorder failed", "error");
      qc.invalidateQueries({ queryKey: ["taskq"] }); // revert optimistic order
    },
  });
  const toggleCollapse = useMutation({
    mutationFn: (v: { status: string; collapsed: boolean }) =>
      setTaskqSectionCollapsed({ [v.status]: v.collapsed }),
    onSuccess: (r) => qc.setQueryData(["taskq-section-prefs"], r),
  });
  const enqueue = useMutation({
    mutationFn: (id: number) => enqueueTaskqTemplate(id),
    onSuccess: (r) => {
      apply(r.board);
      notify("Template enqueued as a new task", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "enqueue failed", "error"),
  });
  const duplicate = useMutation({
    mutationFn: (id: number) => duplicateTaskqTask(id),
    onSuccess: (r) => {
      apply(r.board);
      notify("Duplicated as a new draft", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "duplicate failed", "error"),
  });

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [serialGroupDialogOpen, setSerialGroupDialogOpen] = useState(false);
  const [filterStatus, setFilterStatus] = useState<TaskqStatus | null>(null);
  const { data: serialGroupsData } = useQuery({
    queryKey: ["taskq-serial-groups"],
    queryFn: fetchTaskqSerialGroups,
    enabled: tab === "board",
  });
  const existingSerialGroups = serialGroupsData?.groups ?? [];

  const bulkSerialGroup = useMutation({
    mutationFn: (v: { ids: number[]; serial_group: string | null }) => bulkSetTaskqSerialGroup(v.ids, v.serial_group),
    onSuccess: (r) => {
      apply(r.board);
      void qc.invalidateQueries({ queryKey: ["taskq-serial-groups"] });
      notify("Serial group updated", "success");
      setSelectedIds(new Set());
      setSelectMode(false);
      setSerialGroupDialogOpen(false);
    },
    onError: (e) => notify(e instanceof Error ? e.message : "bulk update failed", "error"),
  });

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setSerialGroupDialogOpen(false);
  };

  /** Commit a within-status reorder: optimistic local order + a before/after move. */
  const onReorder = (curBoard: TaskqBoard, sectionStatus: TaskqStatus, newIds: number[]) => {
    const oldIds = curBoard.tasks.filter((t) => t.status === sectionStatus).map((t) => t.id);
    const moved = findMovedId(oldIds, newIds);
    if (moved == null || newIds.length < 2) return;
    // Optimistic: re-thread this section's tasks into the new order in place.
    const byId = new Map(curBoard.tasks.map((t) => [t.id, t]));
    const ordered = newIds.map((id) => byId.get(id)).filter(Boolean) as TaskqTaskView[];
    let k = 0;
    const tasks = curBoard.tasks.map((t) => (t.status === sectionStatus ? ordered[k++] : t));
    apply({ ...curBoard, tasks });
    const idx = newIds.indexOf(moved);
    const position: TaskqPosition =
      idx > 0 ? { at: "after", anchorId: newIds[idx - 1] } : { at: "before", anchorId: newIds[1] };
    move.mutate({ id: moved, position });
  };

  if (isLoading) return <p className="text-gray-400">loading…</p>;
  if (isError)
    return <Alert tone="error">Failed to load: {error instanceof Error ? error.message : "unknown error"}</Alert>;
  const board = data as TaskqBoard;
  const sectionPrefs = sectionPrefsData?.prefs ?? {};

  return (
    <div className="flex h-full flex-col">
      <PageHeading
        title="Orchestration"
        actions={
          <div className="flex items-center gap-3">
            <UsageMiniStat />
            {tab === "board" && (
              <div className="flex gap-2">
                <button
                  type="button"
                  className={selectMode ? BTN_PRIMARY_CLASS : BTN_GHOST_CLASS}
                  onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                >
                  {selectMode ? "Done" : "Select"}
                </button>
                {!selectMode && (
                  <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => setBuilder({ mode: "create" })}>
                    + New task
                  </button>
                )}
              </div>
            )}
          </div>
        }
      />
      <Tabs<TaskqTab> tabs={TASKQ_TABS} active={tab} onChange={setTab} />

      <div className="min-h-0 flex-1 overflow-auto pt-3">
        {tab === "board" && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter board by status">
              {BOARD_DISPLAY_ORDER.filter((s) => (board.counts[s] ?? 0) > 0).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilterStatus((f) => (f === s ? null : s))}
                  aria-pressed={filterStatus === s}
                  className={`cursor-pointer rounded-full transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${
                    filterStatus === s
                      ? "ring-2 ring-current ring-offset-1"
                      : filterStatus !== null
                        ? "opacity-40 hover:opacity-70"
                        : "hover:opacity-80"
                  }`}
                >
                  <Badge tone={STATUS_TONE[s]}>
                    {TASKQ_STATUS_LABELS[s]}: {board.counts[s]}
                  </Badge>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setFilterStatus(null)}
                aria-pressed={filterStatus === null}
                className={`cursor-pointer rounded-full transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${
                  filterStatus === null
                    ? "ring-2 ring-gray-400 ring-offset-1"
                    : "opacity-40 hover:opacity-70"
                }`}
              >
                <Badge tone="neutral">Total: {board.total}</Badge>
              </button>
            </div>
            <DrainStatusBanner onGoToWorkers={() => setTab("workers")} onGoToUsage={() => setTab("usage")} />
            <InputQueuePanel />
            {board.total === 0 ? (
              <p className="text-gray-400">No tasks yet — add one with "New task".</p>
            ) : (
              (filterStatus ? BOARD_DISPLAY_ORDER.filter((s) => s === filterStatus) : BOARD_DISPLAY_ORDER).flatMap((s) => {
                const allTasks = board.tasks.filter((t) => t.status === s);
                if (allTasks.length === 0) return [];
                const selectProps = { selectMode, selectedIds, onToggleSelect: toggleSelect };
                if (s === "claimed") {
                  // Split claimed tasks: "In Progress" (worker has been heartbeating) vs
                  // "Group: Queued" (bulk-claimed as a group member but no worker started yet —
                  // heartbeat_at == claimed_at because the lease was never renewed).
                  const HEARTBEAT_GRACE_MS = 30_000;
                  const activeTasks = allTasks.filter(
                    (t) => t.heartbeat_at != null && t.claimed_at != null && t.heartbeat_at > t.claimed_at + HEARTBEAT_GRACE_MS,
                  );
                  const queuedTasks = allTasks.filter(
                    (t) => t.heartbeat_at == null || t.claimed_at == null || t.heartbeat_at <= t.claimed_at + HEARTBEAT_GRACE_MS,
                  );
                  const sharedClaimedProps = {
                    status: "claimed" as TaskqStatus,
                    reorderable: false,
                    onEdit: (t: TaskqTaskView) => setBuilder({ mode: "edit", task: t }),
                    onDelete: async (t: TaskqTaskView) => {
                      if (await confirm({ prompt: `Delete "${t.title}"?`, confirmText: "Delete" })) del.mutate(t.id);
                    },
                    onHold: (t: TaskqTaskView) => status.mutate({ id: t.id, status: "on_hold" }),
                    onRequeue: (t: TaskqTaskView) => status.mutate({ id: t.id, status: "ready" }),
                    onEnqueue: (t: TaskqTaskView) => enqueue.mutate(t.id),
                    onDuplicate: (t: TaskqTaskView) => duplicate.mutate(t.id),
                    ...selectProps,
                  };
                  return [
                    activeTasks.length > 0 && (
                      <BoardSection
                        key="claimed-active"
                        {...sharedClaimedProps}
                        tasks={activeTasks}
                        count={activeTasks.length}
                        label="In Progress"
                        collapsed={!!sectionPrefs["claimed"]}
                        onToggleCollapse={() => toggleCollapse.mutate({ status: "claimed", collapsed: !sectionPrefs["claimed"] })}
                        onReorder={(ids) => onReorder(board, "claimed", ids)}
                      />
                    ),
                    queuedTasks.length > 0 && (
                      <BoardSection
                        key="claimed-queued"
                        {...sharedClaimedProps}
                        tasks={queuedTasks}
                        count={queuedTasks.length}
                        label="Group: Queued"
                        collapsed={!!sectionPrefs["claimed"]}
                        onToggleCollapse={() => toggleCollapse.mutate({ status: "claimed", collapsed: !sectionPrefs["claimed"] })}
                        onReorder={(ids) => onReorder(board, "claimed", ids)}
                      />
                    ),
                  ].filter(Boolean);
                }
                if (s !== "on_hold") {
                  const sharedDoneProps = {
                    status: s,
                    reorderable: REORDERABLE.has(s),
                    collapsed: !!sectionPrefs[s],
                    onToggleCollapse: () => toggleCollapse.mutate({ status: s, collapsed: !sectionPrefs[s] }),
                    onReorder: (ids: number[]) => onReorder(board, s, ids),
                    onEdit: (t: TaskqTaskView) => setBuilder({ mode: "edit", task: t }),
                    onDelete: async (t: TaskqTaskView) => {
                      if (await confirm({ prompt: `Delete "${t.title}"?`, confirmText: "Delete" })) del.mutate(t.id);
                    },
                    onHold: (t: TaskqTaskView) =>
                      status.mutate(t.status === "on_hold" ? { id: t.id, status: "ready" } : { id: t.id, status: "on_hold" }),
                    onRequeue: (t: TaskqTaskView) => status.mutate({ id: t.id, status: "ready" }),
                    onEnqueue: (t: TaskqTaskView) => enqueue.mutate(t.id),
                    onDuplicate: (t: TaskqTaskView) => duplicate.mutate(t.id),
                    ...selectProps,
                  };
                  if (s === "done") {
                    // Split done into: regular done + "Done Externally" (transferred to ca orch,
                    // completed there, verified — serial_group='done_externally').
                    const regularDone = allTasks.filter((t) => t.serial_group !== "done_externally");
                    const externallyDone = allTasks.filter((t) => t.serial_group === "done_externally");
                    return [
                      <DoneHistoryAnnotation key="done-stats" />,
                      regularDone.length > 0 && (
                        <BoardSection key="done" {...sharedDoneProps} tasks={regularDone} count={regularDone.length} />
                      ),
                      externallyDone.length > 0 && (
                        <BoardSection
                          key="done-externally"
                          {...sharedDoneProps}
                          tasks={externallyDone}
                          count={externallyDone.length}
                          label="Done Externally"
                          collapsed={!!sectionPrefs["done_externally"]}
                          onToggleCollapse={() => toggleCollapse.mutate({ status: "done_externally", collapsed: !sectionPrefs["done_externally"] })}
                        />
                      ),
                    ].filter(Boolean);
                  }
                  return [
                    <BoardSection key={s} {...sharedDoneProps} tasks={allTasks} count={board.counts[s]} />,
                  ];
                }
                // Split on_hold: saved tasks and templates (things we store to re-run) get their own
                // section; everything else stays in On hold (waiting on something).
                const savedTasks = allTasks.filter((t) => t.is_saved === 1 || t.is_template === 1);
                const holdTasks = allTasks.filter((t) => t.is_saved !== 1 && t.is_template !== 1);
                const sharedProps = {
                  status: "on_hold" as TaskqStatus,
                  reorderable: true,
                  onEdit: (t: TaskqTaskView) => setBuilder({ mode: "edit", task: t }),
                  onDelete: async (t: TaskqTaskView) => {
                    if (await confirm({ prompt: `Delete "${t.title}"?`, confirmText: "Delete" })) del.mutate(t.id);
                  },
                  onHold: (t: TaskqTaskView) => status.mutate({ id: t.id, status: "ready" }),
                  onRequeue: (t: TaskqTaskView) => status.mutate({ id: t.id, status: "ready" }),
                  onEnqueue: (t: TaskqTaskView) => enqueue.mutate(t.id),
                  onDuplicate: (t: TaskqTaskView) => duplicate.mutate(t.id),
                  ...selectProps,
                };
                return [
                  holdTasks.length > 0 && (
                    <BoardSection
                      key="on_hold"
                      {...sharedProps}
                      tasks={holdTasks}
                      count={holdTasks.length}
                      collapsed={!!sectionPrefs["on_hold"]}
                      onToggleCollapse={() => toggleCollapse.mutate({ status: "on_hold", collapsed: !sectionPrefs["on_hold"] })}
                      onReorder={(ids) => onReorder(board, "on_hold", ids)}
                    />
                  ),
                  savedTasks.length > 0 && (
                    <BoardSection
                      key="on_hold_saved"
                      {...sharedProps}
                      label="Saved"
                      tasks={savedTasks}
                      count={savedTasks.length}
                      collapsed={!!sectionPrefs["on_hold_saved"]}
                      onToggleCollapse={() => toggleCollapse.mutate({ status: "on_hold_saved", collapsed: !sectionPrefs["on_hold_saved"] })}
                      onReorder={(ids) => onReorder(board, "on_hold", ids)}
                    />
                  ),
                ].filter(Boolean);
              })
            )}
            {/* Floating action bar when tasks are selected */}
            {selectMode && selectedIds.size > 0 &&
              createPortal(
                <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
                  <div className="flex items-center gap-3 rounded-xl bg-gray-900 px-4 py-3 shadow-2xl dark:bg-gray-800">
                    <span className="text-sm font-medium text-white">{selectedIds.size} selected</span>
                    <button
                      type="button"
                      className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/80"
                      onClick={() => setSerialGroupDialogOpen(true)}
                    >
                      Set serial group
                    </button>
                    <button
                      type="button"
                      className="rounded bg-gray-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-500"
                      onClick={() => bulkSerialGroup.mutate({ ids: [...selectedIds], serial_group: null })}
                      disabled={bulkSerialGroup.isPending}
                    >
                      Clear serial group
                    </button>
                    <button type="button" className="ml-1 text-gray-400 hover:text-white" onClick={exitSelectMode}>
                      ✕
                    </button>
                  </div>
                  {serialGroupDialogOpen && (
                    <SerialGroupDialog
                      existingGroups={existingSerialGroups}
                      isPending={bulkSerialGroup.isPending}
                      onApply={(name) => bulkSerialGroup.mutate({ ids: [...selectedIds], serial_group: name })}
                      onCancel={() => setSerialGroupDialogOpen(false)}
                    />
                  )}
                </div>,
                document.body,
              )
            }
          </div>
        )}
        {tab === "workers" && (
          <div className="space-y-4">
            <DrainerControl onGoToSettings={() => setTab("settings")} />
            <CapacityPanel onGoToSettings={() => setTab("settings")} />
            <InstancesPanel />
            <DrainRunsPanel />
          </div>
        )}
        {tab === "settings" && <SettingsPanel />}
        {tab === "usage" && <UsagePanel />}
        {tab === "forge" && <ForgePage embedded />}
        {tab === "ollama" && <OllamaPage embedded />}
        {tab === "processing" && <OrchestrationProcessingPage embedded />}
        {tab === "findings" && <FindingsLedgerPage embedded />}
      </div>

      {builder && (
        <TaskqBuilderModal
          mode={builder.mode}
          board={board}
          task={builder.mode === "edit" ? builder.task : undefined}
          existingSerialGroups={existingSerialGroups}
          onClose={() => setBuilder(null)}
          onSaved={(b) => {
            apply(b);
            setBuilder(null);
          }}
        />
      )}
    </div>
  );
}

/** Format an epoch-ms timestamp as a short local date+time string. */
function fmtTs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Format an ISO timestamp string (from the tasks table) as a short date+time. */
function fmtIso(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Format a recurrence interval (ms) as a human-readable string. */
function fmtInterval(ms: number): string {
  if (ms >= 7 * 24 * 3600_000 && ms % (7 * 24 * 3600_000) === 0) return `${ms / (7 * 24 * 3600_000)}w`;
  if (ms >= 24 * 3600_000 && ms % (24 * 3600_000) === 0) return `${ms / (24 * 3600_000)}d`;
  if (ms >= 3600_000 && ms % 3600_000 === 0) return `${ms / 3600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

function TaskCard({
  task,
  onEdit,
  onDelete,
  onHold,
  onRequeue,
  onEnqueue,
  onDuplicate,
  dragHandle,
  selectMode,
  isSelected,
  onToggleSelect,
}: {
  task: TaskqTaskView;
  onEdit: () => void;
  onDelete: () => void;
  onHold: () => void;
  onRequeue: () => void;
  onEnqueue: () => void;
  onDuplicate: () => void;
  /** A drag-grip element (from the section's useDragReorder), when reorderable. */
  dragHandle?: React.ReactNode;
  selectMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const editable = task.status !== "claimed" && task.status !== "done";
  const isTemplate = task.is_template === 1;
  const isSaved = task.is_saved === 1;
  // Owner pre-queue draft: never auto-claimed; the owner queues it (→ ready) or
  // duplicates it. Holding a draft makes no sense (it's the owner's space, not a
  // worker park), so the Hold toggle is suppressed for drafts.
  const isDraft = task.status === "draft";
  const sgColor = task.serial_group ? serialGroupColor(task.serial_group) : null;
  const markers = [
    task.model && `model:${task.model}`,
    task.think && `think:${task.think}`,
    task.slug && `id:${task.slug}`,
    task.needs.length > 0 && `needs:${task.needs.join(",")}`,
    task.group_key && `group:${task.group_key}`,
    task.recur_interval_ms != null && `every:${fmtInterval(task.recur_interval_ms)}`,
    task.repo && `repo:${task.repo}`,
  ].filter(Boolean) as string[];

  // Time metadata row varies by status.
  const timeMeta: React.ReactNode = (() => {
    if (task.status === "claimed" && task.claimed_at != null) {
      return (
        <span className="flex flex-wrap gap-x-3">
          <span>created {fmtIso(task.created_at)}</span>
          <span>started {fmtTs(task.claimed_at)}</span>
          <span>running {fmtDur(Date.now() - task.claimed_at)}</span>
        </span>
      );
    }
    if (task.status === "done") {
      const durStr = task.duration_s != null ? `${Math.round(task.duration_s / 60)}m` : null;
      return (
        <span className="flex flex-wrap gap-x-3">
          <span>created {fmtIso(task.created_at)}</span>
          {task.started_at != null && <span>started {fmtTs(task.started_at)}</span>}
          {task.ended_at != null && <span>done {fmtTs(task.ended_at)}</span>}
          {durStr && <span>took {durStr}</span>}
          {task.commit && <span className="font-mono">{task.commit.slice(0, 7)}</span>}
        </span>
      );
    }
    if (task.recur_interval_ms != null && task.recur_next_at != null) {
      return (
        <span className="flex flex-wrap gap-x-3">
          <span>created {fmtIso(task.created_at)}</span>
          <span>next run {fmtTs(task.recur_next_at)}</span>
        </span>
      );
    }
    if (isSaved && task.status === "on_hold") {
      return (
        <span className="flex flex-wrap gap-x-3">
          <span>created {fmtIso(task.created_at)}</span>
          {task.ended_at != null ? (
            <span className="text-sky-500 dark:text-sky-400">
              last run {fmtTs(task.ended_at)}
              {task.duration_s != null ? ` · took ${Math.round(task.duration_s / 60)}m` : ""}
            </span>
          ) : (
            <span className="text-sky-500 dark:text-sky-400">saved — queue to run again</span>
          )}
        </span>
      );
    }
    if (task.status === "on_hold" || task.status === "failed") {
      return (
        <span className="flex flex-wrap gap-x-3">
          <span>created {fmtIso(task.created_at)}</span>
          <span className="text-gray-500">updated {fmtIso(task.updated_at)}</span>
        </span>
      );
    }
    return <span>created {fmtIso(task.created_at)}</span>;
  })();

  return (
    <div
      className={`group ${CARD_CLASS} flex gap-2 p-3 ${sgColor ? `border-l-4 ${sgColor.border}` : ""} ${selectMode ? "cursor-pointer" : ""} ${isSelected ? "ring-2 ring-accent" : ""}`}
      onClick={selectMode ? onToggleSelect : undefined}
    >
      {selectMode && (
        <div className="flex shrink-0 items-start pt-0.5">
          <input
            type="checkbox"
            checked={!!isSelected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 rounded border-gray-300 accent-accent"
          />
        </div>
      )}
      {!selectMode && dragHandle}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">
              <span className="mr-1 text-gray-400">#{task.id}</span>
              {isTemplate && (
                <span className="mr-1.5 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-semibold uppercase text-violet-700 dark:bg-violet-900/50 dark:text-violet-300">
                  template
                </span>
              )}
              {isSaved && !isTemplate && (
                <span className="mr-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-xs font-semibold uppercase text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">
                  saved
                </span>
              )}
              {editable && !selectMode ? (
                <button type="button" onClick={onEdit} className="hover:text-accent hover:underline">
                  {task.title}
                </button>
              ) : (
                task.title
              )}
            </p>
            {(markers.length > 0 || sgColor) && (
              <div className="mt-1 flex flex-wrap gap-1 font-mono text-xs text-gray-500">
                {markers.map((m) => (
                  <span key={m} className="rounded bg-gray-100 px-1 dark:bg-gray-800">
                    {m}
                  </span>
                ))}
                {sgColor && task.serial_group && (
                  <span className={`rounded px-1 font-semibold ${sgColor.bg} ${sgColor.text}`}>
                    serial:{task.serial_group}
                  </span>
                )}
              </div>
            )}
            <div className="mt-1 text-xs text-gray-400">{timeMeta}</div>
            {task.note && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">note: {task.note}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isTemplate && (
              <button type="button" onClick={onEnqueue} className="text-xs font-medium text-violet-600 hover:underline dark:text-violet-400">
                Enqueue
              </button>
            )}
            {isDraft && (
              <button type="button" onClick={onRequeue} className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400">
                Queue
              </button>
            )}
            {(task.status === "failed" || task.status === "on_hold") && (
              <button type="button" onClick={onRequeue} className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400">
                {isSaved && task.status === "on_hold" ? "Queue now" : "Re-queue"}
              </button>
            )}
            {editable && (
              <>
                <button type="button" onClick={onEdit} className="text-xs text-accent hover:underline">
                  Edit
                </button>
                {isDraft && (
                  <button type="button" onClick={onDuplicate} className="text-xs text-gray-600 hover:underline dark:text-gray-400">
                    Duplicate
                  </button>
                )}
                {!isDraft && (
                  <button type="button" onClick={onHold} className="text-xs text-amber-600 hover:underline dark:text-amber-400">
                    {task.status === "on_hold" ? "Unhold" : "Hold"}
                  </button>
                )}
                <button type="button" onClick={onDelete} className="text-xs text-red-600 hover:underline dark:text-red-400">
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
        {(task.body || ((task.status === "done" || (isSaved && task.status === "on_hold")) && task.summary)) && (
          <button type="button" onClick={() => setOpen((o) => !o)} className="mt-2 text-xs text-accent hover:underline">
            {open ? "Hide details" : "Show details"}
          </button>
        )}
        {open && (
          <div className="mt-2 space-y-2">
            {task.body && (
              <pre className="whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-950 dark:text-gray-300">
                {task.body}
              </pre>
            )}
            {(task.status === "done" || (isSaved && task.status === "on_hold")) && task.summary && (
              <div className="rounded-lg bg-emerald-50 p-2 dark:bg-emerald-950/40">
                <p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  {task.status === "done" ? "AI summary" : "Last run summary"}
                </p>
                <pre className="whitespace-pre-wrap text-xs text-emerald-800 dark:text-emerald-300">{task.summary}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A status section that supports drag-to-reorder (priority) via cwip's useDragReorder. */
function BoardSection({
  status,
  label,
  tasks,
  count,
  reorderable,
  collapsed,
  onToggleCollapse,
  onReorder,
  onEdit,
  onDelete,
  onHold,
  onRequeue,
  onEnqueue,
  onDuplicate,
  selectMode,
  selectedIds,
  onToggleSelect,
}: {
  status: TaskqStatus;
  /** Override the section heading; defaults to TASKQ_STATUS_LABELS[status]. */
  label?: string;
  tasks: TaskqTaskView[];
  count: number;
  reorderable: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onReorder: (ids: number[]) => void;
  onEdit: (t: TaskqTaskView) => void;
  onDelete: (t: TaskqTaskView) => void;
  onHold: (t: TaskqTaskView) => void;
  onRequeue: (t: TaskqTaskView) => void;
  onEnqueue: (t: TaskqTaskView) => void;
  onDuplicate: (t: TaskqTaskView) => void;
  selectMode?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
}) {
  const canDrag = reorderable && tasks.length > 1 && !collapsed && !selectMode;
  const {
    items: ordered,
    DragContext,
    Sortable,
  } = useDragReorder({
    items: tasks,
    getKey: (t) => String(t.id),
    onReorder: (next) => onReorder(next.map((t) => t.id)),
    axis: "y",
    handle: true,
    disabled: !canDrag,
  });
  return (
    <section>
      <button
        type="button"
        onClick={onToggleCollapse}
        className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
      >
        <span className={`text-xs transition-transform ${collapsed ? "" : "rotate-90"}`}>▶</span>
        {label ?? TASKQ_STATUS_LABELS[status]} <span className="text-gray-400">({count})</span>
        {!collapsed && canDrag && <span className="ml-2 font-normal normal-case text-gray-400">— drag to reorder priority</span>}
      </button>
      {!collapsed && (
        <DragContext>
          <div className="space-y-2">
            {ordered.map((t) => (
              <Sortable key={t.id} itemKey={String(t.id)}>
                {({ setNodeRef, setActivatorNodeRef, style, handleProps, isDragging }) => (
                  <div ref={setNodeRef} style={style} className={`relative ${isDragging ? "opacity-70" : ""}`}>
                    <TaskCard
                      task={t}
                      onEdit={() => onEdit(t)}
                      onDelete={() => onDelete(t)}
                      onHold={() => onHold(t)}
                      onRequeue={() => onRequeue(t)}
                      onEnqueue={() => onEnqueue(t)}
                      onDuplicate={() => onDuplicate(t)}
                      selectMode={selectMode}
                      isSelected={selectedIds?.has(t.id)}
                      onToggleSelect={() => onToggleSelect?.(t.id)}
                      dragHandle={
                        canDrag ? (
                          <DragHandle
                            handleProps={handleProps}
                            activatorRef={setActivatorNodeRef}
                            label={`Reorder ${t.title}`}
                          />
                        ) : undefined
                      }
                    />
                  </div>
                )}
              </Sortable>
            ))}
          </div>
        </DragContext>
      )}
    </section>
  );
}

/** Small popup for naming/choosing a serial group when applying via the action bar. */
function SerialGroupDialog({
  existingGroups,
  isPending,
  onApply,
  onCancel,
}: {
  existingGroups: string[];
  isPending: boolean;
  onApply: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="mt-2 rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 shadow-2xl dark:bg-gray-800">
      <p className="mb-2 text-sm font-medium text-white">Serial group name</p>
      <input
        autoFocus
        className="mb-3 w-full rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
        placeholder="e.g. deploy-sequence"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        list="serial-group-datalist-bar"
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onApply(value.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <datalist id="serial-group-datalist-bar">
        {existingGroups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-accent/80"
          disabled={!value.trim() || isPending}
          onClick={() => onApply(value.trim())}
        >
          Apply
        </button>
        <button type="button" className="rounded bg-gray-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-500" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Multi-select for task dependencies (`needs:`) — pick by id + title from a
 *  searchable dropdown rendered in a portal so it's never clipped by the modal.
 *  Supports "#39" or "39" searches to find a task by its board number. */
function NeedsSelect({
  board,
  value,
  onChange,
  excludeId,
}: {
  board: TaskqBoard;
  value: string[];
  onChange: (next: string[]) => void;
  excludeId?: number;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [custom, setCustom] = useState("");
  const [dropRect, setDropRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // All tasks can be depended on — server auto-assigns numeric slugs so every
  // task has an addressable id. Fallback: use String(id) if slug is somehow absent.
  const options = board.tasks.filter((t) => t.id !== excludeId);
  const effectiveSlug = (t: TaskqTaskView) => t.slug ?? String(t.id);
  // Strip leading "#" so "#39" searches find the task with id/slug "39".
  const f = filter.trim().replace(/^#/, "").toLowerCase();
  const filtered = f
    ? options.filter((o) => `${effectiveSlug(o)} ${o.title}`.toLowerCase().includes(f))
    : options;
  const toggle = (slug: string) => onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug]);
  const addCustom = () => {
    if (custom.trim()) {
      toggle(custom.trim());
      setCustom("");
    }
  };

  const openDropdown = useCallback(() => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Position below button; if close to bottom of screen, flip up.
      const spaceBelow = window.innerHeight - r.bottom;
      const dropHeight = Math.min(320, window.innerHeight * 0.5);
      const top = spaceBelow >= dropHeight ? r.bottom + 4 : r.top - dropHeight - 4;
      setDropRect({ top, left: r.left, width: r.width });
    }
    setOpen(true);
    setFilter("");
  }, []);

  // Reposition on scroll/resize while open.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      if (btnRef.current) {
        const r = btnRef.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - r.bottom;
        const dropHeight = Math.min(320, window.innerHeight * 0.5);
        const top = spaceBelow >= dropHeight ? r.bottom + 4 : r.top - dropHeight - 4;
        setDropRect({ top, left: r.left, width: r.width });
      }
    };
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  const dropdown = open && dropRect
    ? createPortal(
        <>
          <button
            type="button"
            aria-label="close dropdown"
            className="fixed inset-0 cursor-default"
            style={{ zIndex: 9998 }}
            onClick={() => setOpen(false)}
          />
          <div
            className="overflow-auto rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900"
            style={{
              position: "fixed",
              zIndex: 9999,
              top: dropRect.top,
              left: dropRect.left,
              width: Math.max(dropRect.width, 300),
              maxHeight: Math.min(320, window.innerHeight * 0.5),
            }}
          >
            {/* biome-ignore lint/a11y/noAutofocus: focusing the filter on open is the intended UX */}
            <input autoFocus className={FIELD_CLASS} placeholder="filter by #number, id, or title…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="mt-2 space-y-0.5">
              {filtered.map((o) => {
                const slug = effectiveSlug(o);
                const isNumeric = slug === String(o.id);
                return (
                  <label
                    key={o.id}
                    title={o.body || undefined}
                    className="flex cursor-pointer items-start gap-2 rounded p-1.5 hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    <input
                      type="checkbox"
                      checked={value.includes(slug)}
                      onChange={() => toggle(slug)}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <span className="min-w-0">
                      {isNumeric ? (
                        <span className="font-mono text-xs text-gray-400">#{o.id}</span>
                      ) : (
                        <>
                          <span className="font-mono text-xs text-gray-400">#{o.id}</span>
                          {" "}
                          <span className="font-mono text-xs text-accent">{slug}</span>
                        </>
                      )}
                      {" "}
                      <span className="text-sm">{o.title}</span>
                      {o.body && <span className="block truncate text-xs text-gray-400">{o.body}</span>}
                    </span>
                  </label>
                );
              })}
              {filtered.length === 0 && (
                <p className="px-1 py-2 text-xs text-gray-400">
                  No tasks match. Search by #number, slug id, or title.
                </p>
              )}
            </div>
            <div className="mt-2 flex gap-1 border-t border-gray-200 pt-2 dark:border-gray-700">
              <input
                className={FIELD_CLASS}
                placeholder="custom id…"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
              />
              <button type="button" className={BTN_GHOST_CLASS} onClick={addCustom}>
                Add
              </button>
            </div>
          </div>
        </>,
        document.body,
      )
    : null;

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={open ? () => setOpen(false) : openDropdown}
        className={`${FIELD_CLASS} flex min-h-[2.4rem] flex-wrap items-center gap-1 text-left`}
      >
        {value.length === 0 ? (
          <span className="text-gray-400">select dependencies…</span>
        ) : (
          value.map((s) => (
            <span key={s} className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">
              {s}
              <span
                role="button"
                tabIndex={-1}
                aria-label={`remove ${s}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(s);
                }}
                className="cursor-pointer hover:opacity-70"
              >
                ✕
              </span>
            </span>
          ))
        )}
      </button>
      {dropdown}
    </div>
  );
}

function TaskqBuilderModal({
  mode,
  board,
  task,
  existingSerialGroups,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  board: TaskqBoard;
  task?: TaskqTaskView;
  existingSerialGroups: string[];
  onClose: () => void;
  onSaved: (board: TaskqBoard) => void;
}) {
  const { notify } = useToast();
  type Scheduling = "oneshot" | "saved" | "interval" | "template";

  function initialScheduling(t?: TaskqTaskView): Scheduling {
    if (t?.is_template === 1) return "template";
    if (t?.is_saved === 1 && t?.recur_interval_ms != null) return "interval";
    if (t?.is_saved === 1) return "saved";
    return "oneshot";
  }

  function initialIntervalN(t?: TaskqTaskView): string {
    if (t?.recur_interval_ms == null) return "1";
    const ms = t.recur_interval_ms;
    if (ms >= 7 * 24 * 3600_000 && ms % (7 * 24 * 3600_000) === 0) return String(ms / (7 * 24 * 3600_000));
    if (ms >= 24 * 3600_000 && ms % (24 * 3600_000) === 0) return String(ms / (24 * 3600_000));
    if (ms >= 3600_000 && ms % 3600_000 === 0) return String(ms / 3600_000);
    return String(Math.round(ms / 60_000));
  }

  function initialIntervalUnit(t?: TaskqTaskView): string {
    if (t?.recur_interval_ms == null) return "hours";
    const ms = t.recur_interval_ms;
    if (ms >= 7 * 24 * 3600_000 && ms % (7 * 24 * 3600_000) === 0) return "weeks";
    if (ms >= 24 * 3600_000 && ms % (24 * 3600_000) === 0) return "days";
    if (ms >= 3600_000 && ms % 3600_000 === 0) return "hours";
    return "minutes";
  }

  // New owner-created tasks default to draft — they land in the owner's pre-queue
  // Drafts section (never auto-claimed) until the owner promotes them → ready.
  const [statusV, setStatusV] = useState<TaskqStatus>(task?.status ?? (mode === "create" ? "draft" : "ready"));
  const [title, setTitle] = useState(task?.title ?? "");
  const [body, setBody] = useState(task?.body ?? "");
  const derivedTitle = useMemo(() => deriveTaskTitle(body), [body]);
  const [model, setModel] = useState(task?.model ?? "");
  const [think, setThink] = useState(task?.think ?? "");
  const [slug, setSlug] = useState(task?.slug ?? "");
  const [repo, setRepo] = useState(task?.repo ?? "");
  const [needs, setNeeds] = useState<string[]>(task?.needs ?? []);
  const [group, setGroup] = useState(task?.group_key ?? "");
  const [serialGroup, setSerialGroup] = useState(task?.serial_group ?? "");
  const [scheduling, setScheduling] = useState<Scheduling>(initialScheduling(task));
  const [intervalN, setIntervalN] = useState(initialIntervalN(task));
  const [intervalUnit, setIntervalUnit] = useState(initialIntervalUnit(task));
  const [note, setNote] = useState(task?.note ?? "");
  const [posAt, setPosAt] = useState<TaskqPosition["at"]>("top");
  const [posAnchor, setPosAnchor] = useState<number | "">(board.tasks[0]?.id ?? "");

  const unitMs: Record<string, number> = { minutes: 60_000, hours: 3600_000, days: 86400_000, weeks: 604800_000 };
  const intervalMs = scheduling === "interval" ? (Number.parseInt(intervalN, 10) || 1) * (unitMs[intervalUnit] ?? 3600_000) : undefined;

  const draft: TaskqNewTask = {
    title: title.trim() || derivedTitle,
    status: scheduling === "template" ? "on_hold" : statusV,
    body: body.trim() || undefined,
    model: model || undefined,
    think: think || undefined,
    slug: slug.trim() || undefined,
    repo: repo.trim() || undefined,
    needs,
    group_key: group.trim() || undefined,
    serial_group: serialGroup.trim() || undefined,
    recur_interval_ms: intervalMs,
    is_saved: scheduling === "saved" || scheduling === "interval",
    is_template: scheduling === "template",
    note: note.trim() || undefined,
  };

  const needsAnchor = mode === "create" && (posAt === "before" || posAt === "after");

  const save = useMutation({
    mutationFn: async () => {
      if (mode === "create") {
        const position: TaskqPosition =
          needsAnchor && typeof posAnchor === "number" ? { at: posAt, anchorId: posAnchor } : { at: posAt as "top" | "bottom" };
        return (await createTaskqTask(draft, position)).board;
      }
      if (!task) throw new Error("no task");
      // Send the full editable set as a patch (engine clears '' → null).
      // Always include recur_n: null when switching away from count-based legacy
      // mode so a count-based task can be migrated to time-based or template.
      return (
        await updateTaskqTask(task.id, {
          title: title.trim() || derivedTitle,
          status: scheduling === "template" ? "on_hold" : statusV,
          body,
          model,
          think,
          slug,
          repo,
          needs,
          group_key: group,
          serial_group: serialGroup,
          note,
          recur_n: null,
          recur_interval_ms: intervalMs ?? null,
          is_saved: scheduling === "saved" || scheduling === "interval",
          is_template: scheduling === "template",
        })
      ).board;
    },
    onSuccess: (board) => {
      notify(mode === "create" ? "Task added" : "Task updated", "success");
      onSaved(board);
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const titleError = !title.trim() && !derivedTitle;

  return (
    <ModalShell
      size="lg"
      title={mode === "create" ? "New task" : `Edit task #${task?.id}`}
      subtitle="Backed by the SQLite queue — validated by the engine."
      onClose={onClose}
      confirmOnClose
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={onClose} disabled={save.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className={BTN_PRIMARY_CLASS}
            disabled={titleError || (needsAnchor && posAnchor === "") || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Spinner />}
            {mode === "create" ? "Add task" : "Save"}
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Status">
          <select className={FIELD_CLASS} value={statusV} onChange={(e) => setStatusV(e.target.value as TaskqStatus)}>
            {TASKQ_AUTHORABLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TASKQ_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>

        {mode === "create" && (
          <Field label="Position">
            <div className="flex gap-2">
              <select className={FIELD_CLASS} value={posAt} onChange={(e) => setPosAt(e.target.value as TaskqPosition["at"])}>
                <option value="top">Top (highest priority)</option>
                <option value="bottom">Bottom</option>
                <option value="before">Before…</option>
                <option value="after">After…</option>
              </select>
              {needsAnchor && (
                <select
                  className={FIELD_CLASS}
                  value={posAnchor}
                  onChange={(e) => setPosAnchor(e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">— task —</option>
                  {board.tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      #{t.id} {t.title.slice(0, 50)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Field>
        )}

        <div className="md:col-span-2">
          <Field label="Title" hint={!title.trim() && derivedTitle ? `Will use: "${derivedTitle}"` : "Optional — derived from details if blank"}>
            <input className={FIELD_CLASS} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={derivedTitle || "What to do"} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Details">
            <textarea className={`${FIELD_CLASS} min-h-[5rem] font-mono`} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
        </div>

        <Field label="Model">
          <select className={FIELD_CLASS} value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Default (triage / drainer)</option>
            {TASKQ_MODEL_ALIASES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Thinking">
          <select className={FIELD_CLASS} value={think} onChange={(e) => setThink(e.target.value)}>
            <option value="">Default</option>
            {TASKQ_THINK_LEVELS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Repo">
          <input className={FIELD_CLASS} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="ca | ru | cwip" />
        </Field>
        <Field label="Id (slug)">
          <input className={FIELD_CLASS} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="vault-ui" />
        </Field>
        <Field label="Needs (dependencies)">
          <NeedsSelect board={board} value={needs} onChange={setNeeds} excludeId={task?.id} />
        </Field>
        <Field label="Group">
          <input className={FIELD_CLASS} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="vault" />
        </Field>
        <Field label="Serial group" hint="Only one task in the group runs at a time">
          <input
            className={FIELD_CLASS}
            value={serialGroup}
            onChange={(e) => setSerialGroup(e.target.value)}
            placeholder="e.g. deploy-sequence"
            list="serial-group-datalist"
          />
          <datalist id="serial-group-datalist">
            {existingSerialGroups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </Field>

        <div className="md:col-span-2">
          <Field
            label="Scheduling"
            hint="One-shot tasks are done after completion. Saved tasks return to on-hold so you can re-queue them manually. Saved + interval tasks auto-schedule on a repeating schedule."
          >
            <div className="space-y-2">
              <div className="flex flex-wrap gap-3">
                {(["oneshot", "saved", "interval", "template"] as const).map((s) => (
                  <label key={s} className="flex cursor-pointer items-center gap-1.5 text-sm">
                    <input type="radio" name="scheduling" value={s} checked={scheduling === s} onChange={() => setScheduling(s)} className="h-4 w-4" />
                    {s === "oneshot" && "One-shot (run once, done)"}
                    {s === "saved" && "Saved (on-hold after run — queue manually)"}
                    {s === "interval" && "Saved + interval (auto-schedules on repeat)"}
                    {s === "template" && "Template (enqueue a fresh copy on demand)"}
                  </label>
                ))}
              </div>
              {scheduling === "interval" && (
                <>
                  <div className="flex items-center gap-2 pl-6">
                    <span className="text-sm text-gray-500">every</span>
                    <input
                      type="number"
                      min={1}
                      className={`${FIELD_CLASS} w-20`}
                      value={intervalN}
                      onChange={(e) => setIntervalN(e.target.value)}
                    />
                    <select className={`${FIELD_CLASS} w-32`} value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value)}>
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                      <option value="weeks">weeks</option>
                    </select>
                  </div>
                  <p className="pl-6 text-xs text-gray-400">
                    After each run the task schedules its next execution automatically. Good for recurring health checks, weekly sweeps, and timed maintenance.
                  </p>
                </>
              )}
              {scheduling === "saved" && (
                <p className="pl-6 text-xs text-gray-400">
                  The task goes to <strong>on-hold</strong> after completion and waits for you to queue it again via the <strong>Queue now</strong> button. Good for tasks you run on your own schedule.
                </p>
              )}
              {scheduling === "template" && (
                <p className="pl-6 text-xs text-gray-400">
                  The template is never auto-claimed. Click <strong>Enqueue</strong> to send a fresh copy to the worker queue each time you want it to run.
                </p>
              )}
            </div>
          </Field>
        </div>
        <Field label="Note (why on-hold/blocked)">
          <input className={FIELD_CLASS} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </ModalShell>
  );
}

const BUCKET_LABELS: Record<string, string> = {
  session_5h: "Session (5h)",
  weekly_total: "Weekly total",
  weekly_sonnet: "Weekly Sonnet",
};

/**
 * Banner shown on the Board tab when the drain is blocked from running.
 * The Workers tab already has CapacityPanel for the full detail view; this
 * surfaces the critical "nothing is happening" signal where users actually look.
 */
function DrainStatusBanner({ onGoToWorkers, onGoToUsage }: { onGoToWorkers: () => void; onGoToUsage: () => void }) {
  const { data: cap } = useQuery({ queryKey: ["taskq-capacity"], queryFn: fetchTaskqCapacity, refetchInterval: 8000 });
  const { data: s } = useQuery({ queryKey: ["taskq-drainer"], queryFn: fetchTaskqDrainer, refetchInterval: 5000 });
  const qc = useQueryClient();
  const { notify } = useToast();

  const calibrate = useMutation({
    mutationFn: (key: string) => calibrateTaskqBucket({ key, consumedFraction: 0, resetAt: Date.now() }),
    onSuccess: (r) => {
      qc.setQueryData(["taskq-usage"], r);
      qc.invalidateQueries({ queryKey: ["taskq-capacity"] });
      notify("Calibrated to 0% consumed — drain will resume on next tick", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "calibrate failed", "error"),
  });

  // Fire a real probe to learn whether we're actually out, then auto-recalibrate.
  const recheck = useMutation({
    mutationFn: probeTaskqCapacity,
    onSuccess: (r) => {
      qc.setQueryData(["taskq-usage"], { buckets: r.buckets });
      qc.invalidateQueries({ queryKey: ["taskq-capacity"] });
      if (r.probe.rateLimited) notify("Probe confirms you're actually out of tokens — estimate kept", "info");
      else if (r.reconciled.length > 0) notify("Not actually out — estimate corrected upward", "success");
      else notify("Capacity looks fine — no change needed", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "re-check failed", "error"),
  });

  const stopped = s?.stopped;
  const throttled = !stopped && cap?.decision.preferLight;
  const exhausted = cap?.buckets.filter((b) => b.fraction <= 0) ?? [];

  if (!stopped && !throttled) return null;

  if (stopped) {
    return (
      <Alert tone="warning" title="Drain stopped — graceful stop is active">
        Workers won't claim new tasks until you resume.{" "}
        <button type="button" className="font-medium underline" onClick={onGoToWorkers}>
          Go to Workers tab
        </button>{" "}
        and click Resume.
      </Alert>
    );
  }

  return (
    <Alert
      tone="warning"
      title="Drain throttled — low token capacity"
      actions={
        exhausted.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={BTN_PRIMARY_CLASS}
              disabled={recheck.isPending}
              onClick={() => recheck.mutate()}
            >
              {recheck.isPending && <Spinner />}
              I'm not actually out — re-check
            </button>
            {exhausted.map((b) => (
              <button
                key={b.key}
                type="button"
                className={BTN_GHOST_CLASS}
                disabled={calibrate.isPending}
                onClick={() => calibrate.mutate(b.key)}
              >
                {calibrate.isPending && <Spinner />}
                Reset {BUCKET_LABELS[b.key] ?? b.key} to 100%
              </button>
            ))}
            <button type="button" className={BTN_GHOST_CLASS} onClick={onGoToUsage}>
              Usage tab ↗
            </button>
          </div>
        ) : undefined
      }
    >
      Running 1 light-model worker per pass to conserve tokens.
      {exhausted.length > 0 && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {exhausted.map((b) => {
            const h = b.resetInSeconds != null ? Math.ceil(b.resetInSeconds / 3600) : null;
            return (
              <span key={b.key}>
                <strong>{BUCKET_LABELS[b.key] ?? b.key}</strong> shows 0% remaining
                {h != null ? ` (auto-resets in ~${h}h)` : ""}
                {" — "}
              </span>
            );
          })}
          this is only a local estimate. The drain self-corrects: a real call that
          goes through (a task, or the re-check above) proves you're not out and
          nudges the estimate to track your true limit.
        </p>
      )}
      {exhausted.length === 0 && (
        <>{" "}<button type="button" className="underline" onClick={onGoToWorkers}>
          Workers tab
        </button>{" "}
        for details and calibration.</>
      )}
    </Alert>
  );
}

// ── Live-usage formatting helpers ────────────────────────────────────────────

/** Compact token count: 1.2B / 26.8M / 4.1K. */
function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** USD with thousands separators, two decimals. */
function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Human relative time, e.g. "12m ago". null → "never". */
function relTime(at: number | null): string {
  if (at == null) return "never";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Drop the `claude-` prefix for chart labels. */
function shortModel(name: string): string {
  return name.replace(/^claude-/, "");
}

/** 🟢 Live / 🟡 Fallback / ⚪ none — a source-freshness badge. */
function UsageSourceBadge({ status, at, label }: { status: string; at: number | null; label: string }) {
  if (status === "live")
    return (
      <Badge tone="success">
        🟢 Live {label} · {relTime(at)}
      </Badge>
    );
  if (status === "fallback")
    return (
      <Badge tone="warn">
        🟡 {label} stale{at != null ? ` · ${relTime(at)}` : ""}
      </Badge>
    );
  return <Badge tone="neutral">⚪ No {label} yet</Badge>;
}

/** One look-back window of behavioral telemetry (24h / 7d). */
function PeriodBlock({ title, period }: { title: string; period: TaskqClaudeTelemetry["historicalAnalysis"]["last24h"] }) {
  const behaviors = Object.entries(period.behaviors);
  const skills = Object.entries(period.topSkills);
  const subagents = Object.entries(period.topSubagents);
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{title}</h4>
        <span className="text-xs text-gray-400">
          {period.requests.toLocaleString()} requests · {period.sessions.toLocaleString()} sessions
        </span>
      </div>
      <div className="space-y-1">
        {behaviors.map(([label, pct]) => {
          const v = Number.parseInt(pct, 10) || 0;
          return (
            <div key={label} className="flex items-center gap-2 text-xs">
              <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, v)}%` }} />
              </div>
              <span className="w-8 shrink-0 text-right font-medium text-gray-600 dark:text-gray-400">{pct}</span>
              <span className="text-gray-500">{label}</span>
            </div>
          );
        })}
        {behaviors.length === 0 && <span className="text-xs text-gray-400">No behavioral signals.</span>}
      </div>
      {(skills.length > 0 || subagents.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {skills.map(([k, v]) => (
            <span key={`s-${k}`} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              {k} {v}
            </span>
          ))}
          {subagents.map(([k, v]) => (
            <span key={`a-${k}`} className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
              {k} {v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Behavioral diagnostics from the live `/usage` telemetry. */
function DiagnosticsCard({ telemetry }: { telemetry: TaskqClaudeTelemetry }) {
  return (
    <div className={`${CARD_CLASS} mb-3 p-4`}>
      <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">Usage diagnostics</h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PeriodBlock title="Last 24h" period={telemetry.historicalAnalysis.last24h} />
        <PeriodBlock title="Last 7d" period={telemetry.historicalAnalysis.last7d} />
      </div>
    </div>
  );
}

/** Daily cost + token breakdown from ccusage. */
function CostCard({ cost }: { cost: TaskqCcusageReport }) {
  const recent = cost.daily.slice(-14);
  const trend = recent.map((d) => ({ ts: new Date(d.period).getTime(), cost: d.totalCost }));
  const byModel = new Map<string, number>();
  for (const day of cost.daily) {
    for (const b of day.modelBreakdowns) byModel.set(b.modelName, (byModel.get(b.modelName) ?? 0) + b.cost);
  }
  const modelBars: ChartDatum[] = [...byModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, c]) => ({ label: shortModel(name), value: c }));

  return (
    <div className={`${CARD_CLASS} p-4`}>
      <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">Cost &amp; tokens</h3>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total cost" value={fmtUsd(cost.totals.totalCost)} />
        <StatTile label="Total tokens" value={fmtTokens(cost.totals.totalTokens)} />
        <StatTile label="Output tokens" value={fmtTokens(cost.totals.outputTokens)} />
        <StatTile label="Days tracked" value={String(cost.daily.length)} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-semibold text-gray-500">Daily cost (last {recent.length}d)</h4>
          <AreaChart
            data={trend}
            xKey="ts"
            series={[{ dataKey: "cost", name: "Cost" }]}
            ariaLabel="Daily cost"
            height={220}
            valueFormatter={fmtUsd}
            yWidth={72}
            xTickFormatter={(v) => formatTimeTick(Number(v), true)}
            labelFormatter={(v) => formatTimeFull(Number(v))}
          />
        </div>
        <div>
          <h4 className="mb-2 text-xs font-semibold text-gray-500">Cost by model</h4>
          <BarChart
            data={modelBars}
            xKey="label"
            series={[{ dataKey: "value", name: "Cost" }]}
            ariaLabel="Cost by model"
            orientation="horizontal"
            height={220}
            yWidth={72}
            valueFormatter={fmtUsd}
          />
        </div>
      </div>
    </div>
  );
}

/** Inline editor for the background poll intervals (minutes; 0 = off / manual only). */
function UsagePollSettings() {
  const { data } = useQuery({ queryKey: ["taskq-config"], queryFn: fetchTaskqConfig });
  const qc = useQueryClient();
  const { notify } = useToast();
  const [edit, setEdit] = useState(false);
  const [tel, setTel] = useState("");
  const [cost, setCost] = useState("");
  const cfg = data?.config;

  const startEdit = () => {
    setTel(String(cfg?.usagePollMinutes ?? 5));
    setCost(String(cfg?.usageCostPollMinutes ?? 30));
    setEdit(true);
  };

  const save = useMutation({
    mutationFn: () =>
      saveTaskqConfig({
        usagePollMinutes: Math.max(0, Math.round(Number(tel) || 0)),
        usageCostPollMinutes: Math.max(0, Math.round(Number(cost) || 0)),
      }),
    onSuccess: (r) => {
      qc.setQueryData(["taskq-config"], r);
      setEdit(false);
      notify("Polling interval saved", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  if (!cfg) return null;
  const fmt = (m: number) => (m > 0 ? `every ${m}m` : "off (manual only)");

  return (
    <div className="mt-3 border-t border-gray-200 pt-2 text-xs dark:border-gray-700">
      {!edit ? (
        <div className="flex flex-wrap items-center gap-2 text-gray-500">
          <span>
            Auto-poll — <code>/usage</code> {fmt(cfg.usagePollMinutes)} · cost {fmt(cfg.usageCostPollMinutes)}
          </span>
          <button type="button" className="text-accent hover:underline" onClick={startEdit}>
            Edit
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label>
            <span className="mb-1 block text-gray-500">
              <code>/usage</code> every (min, 0 = off)
            </span>
            <input
              type="number"
              min={0}
              max={1440}
              className={`${FIELD_CLASS} w-32`}
              value={tel}
              onChange={(e) => setTel(e.target.value)}
            />
          </label>
          <label>
            <span className="mb-1 block text-gray-500">cost every (min, 0 = off)</span>
            <input
              type="number"
              min={0}
              max={1440}
              className={`${FIELD_CLASS} w-32`}
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </label>
          <button type="button" className={BTN_PRIMARY_CLASS} disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Spinner />}Save
          </button>
          <button type="button" className="text-gray-500 hover:underline" onClick={() => setEdit(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** Token-usage capacities + live `/usage` telemetry, cost, and a fallback calibration form. */
function UsagePanel() {
  const { data } = useQuery({ queryKey: ["taskq-usage"], queryFn: fetchTaskqUsage });
  const { data: live } = useQuery({
    queryKey: ["taskq-usage-live"],
    queryFn: fetchTaskqUsageLive,
    refetchInterval: 60_000,
  });
  const qc = useQueryClient();
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("session_5h");
  const [pct, setPct] = useState("0");
  const [resetH, setResetH] = useState("");

  const calibrate = useMutation({
    mutationFn: () =>
      calibrateTaskqBucket({
        key,
        consumedFraction: Math.max(0, Math.min(1, Number(pct) / 100)),
        resetAt: resetH ? Date.now() + Number(resetH) * 3600_000 : undefined,
      }),
    onSuccess: (r) => {
      qc.setQueryData(["taskq-usage"], r);
      notify("Calibrated", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "calibrate failed", "error"),
  });

  const refresh = useMutation({
    mutationFn: refreshTaskqUsage,
    onSuccess: (snap: TaskqUsageSnapshot) => {
      qc.setQueryData(["taskq-usage-live"], snap);
      qc.invalidateQueries({ queryKey: ["taskq-usage"] });
      qc.invalidateQueries({ queryKey: ["taskq-capacity"] });
      notify(snap.telemetryStatus === "live" ? "Usage refreshed" : "Refresh failed — using last good data", snap.telemetryStatus === "live" ? "success" : "info");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "refresh failed", "error"),
  });

  const buckets = data?.buckets ?? [];
  const telemetryLive = live?.telemetryStatus === "live";
  // Map a bucket → its real reset string from the live telemetry, when present.
  const resetForBucket: Record<string, string | undefined> = {
    session_5h: live?.telemetry?.limits.currentSession.resetsAt,
    weekly_total: live?.telemetry?.limits.weeklyAllModels.resetsAt,
    weekly_sonnet: live?.telemetry?.limits.weeklySonnetOnly.resetsAt,
  };

  return (
    <>
      <div className={`${CARD_CLASS} mb-3 p-3`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 pb-2 dark:border-gray-700">
          <div className="flex flex-wrap items-center gap-2">
            <UsageSourceBadge status={live?.telemetryStatus ?? "never"} at={live?.telemetryAt ?? null} label="/usage" />
            <UsageSourceBadge status={live?.costStatus ?? "never"} at={live?.costAt ?? null} label="cost" />
          </div>
          <div className="flex items-center gap-3">
            <button type="button" className={BTN_GHOST_CLASS} onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              {refresh.isPending && <Spinner />}Refresh now
            </button>
            <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs text-accent hover:underline">
              {open ? "Close" : "Calibrate"}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-4">
          {buckets.map((b: TaskqBucketState) => {
            const pctRemain = Math.round(b.fraction * 100);
            const tone = b.fraction < 0.12 ? "text-red-600" : b.fraction < 0.4 ? "text-amber-600" : "text-emerald-600";
            const resetStr = resetForBucket[b.key];
            return (
              <div key={b.key} className="text-xs">
                <div className="text-gray-500">{BUCKET_LABELS[b.key] ?? b.key}</div>
                <div className={`font-semibold ${tone}`}>
                  {pctRemain}% left
                  {resetStr ? (
                    <span className="ml-1 font-normal text-gray-400">· resets {resetStr}</span>
                  ) : b.resetInSeconds != null ? (
                    <span className="ml-1 font-normal text-gray-400">· resets {Math.round(b.resetInSeconds / 3600)}h</span>
                  ) : null}
                </div>
              </div>
            );
          })}
          {buckets.length === 0 && <span className="text-xs text-gray-400">No usage data — calibrate from /usage.</span>}
        </div>

        <UsagePollSettings />

        {open && (
          <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
            {telemetryLive && (
              <p className="mb-2 text-xs text-gray-500">
                Live syncing is active — buckets auto-calibrate from <code>/usage</code>. Manual entry below is only needed as a fallback.
              </p>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs">
                <span className="mb-1 block text-gray-500">Bucket</span>
                <select className={`${FIELD_CLASS} w-40`} value={key} onChange={(e) => setKey(e.target.value)}>
                  {Object.entries(BUCKET_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                <span className="mb-1 block text-gray-500">Consumed %</span>
                <input type="number" min={0} max={100} className={`${FIELD_CLASS} w-24`} value={pct} onChange={(e) => setPct(e.target.value)} />
              </label>
              <label className="text-xs">
                <span className="mb-1 block text-gray-500">Resets in (h)</span>
                <input type="number" min={0} className={`${FIELD_CLASS} w-24`} value={resetH} onChange={(e) => setResetH(e.target.value)} />
              </label>
              <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => calibrate.mutate()} disabled={calibrate.isPending}>
                {calibrate.isPending && <Spinner />}Save reading
              </button>
            </div>
          </div>
        )}
      </div>

      {live?.telemetry && <DiagnosticsCard telemetry={live.telemetry} />}
      {live?.cost && live.cost.daily.length > 0 && <CostCard cost={live.cost} />}
    </>
  );
}

/** Compact session-usage indicator for the orchestration page header. */
function UsageMiniStat() {
  const { data: live } = useQuery({
    queryKey: ["taskq-usage-live"],
    queryFn: fetchTaskqUsageLive,
    refetchInterval: 60_000,
  });
  const session = live?.telemetry?.limits.currentSession;
  if (!session || session.percentUsed === "Unknown") return null;
  const dot = live?.telemetryStatus === "live" ? "bg-emerald-500" : "bg-amber-500";
  return (
    <span className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400" title={`Session resets ${session.resetsAt}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      Session {session.percentUsed} used
    </span>
  );
}

const BUCKET_LABELS_SHORT: Record<string, string> = {
  session_5h: "Session",
  weekly_total: "Weekly",
  weekly_sonnet: "Sonnet",
};

const BUCKET_FULL_LABELS: Record<string, string> = {
  session_5h: "5-hour session",
  weekly_total: "weekly total",
  weekly_sonnet: "weekly Sonnet",
};

/**
 * Capacity panel — shows the schedule decision the next drain pass would make,
 * which worker slots exist, and which ready tasks can/cannot be claimed.
 */
function CapacityPanel({ onGoToSettings }: { onGoToSettings: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["taskq-capacity"],
    queryFn: fetchTaskqCapacity,
    refetchInterval: 8000,
  });
  const [readyOpen, setReadyOpen] = useState(true);

  if (isLoading || !data) return null;
  const cap: TaskqCapacity = data;

  const decisionTone =
    cap.decision.preferLight
      ? "text-amber-600 dark:text-amber-400"
      : cap.decision.burnExpiring
        ? "text-blue-600 dark:text-blue-400"
        : "text-emerald-600 dark:text-emerald-400";

  const decisionLabel =
    cap.decision.preferLight
      ? "Throttled"
      : cap.decision.burnExpiring
        ? "Burning expiring"
        : "Normal";

  const throttled = cap.effectiveJobs < cap.maxJobs;

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Drain capacity</h3>

      {/* Schedule decision */}
      <div className={`${CARD_CLASS} mb-2 p-3`}>
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          {/* Status */}
          <div className="min-w-[140px]">
            <Tooltip multiline content="The scheduling decision the next drain pass will make, based on current token bucket levels. Paused = no workers; Throttled = 1 light-model worker; Burning expiring = full capacity; Normal = full capacity.">
              <div className="mb-1 cursor-help text-xs font-medium uppercase tracking-wide text-gray-500 underline decoration-dotted">Status</div>
            </Tooltip>
            <div className={`font-semibold ${decisionTone}`}>{decisionLabel}</div>
            <div className="mt-0.5 min-w-0 break-words text-xs text-gray-500 dark:text-gray-400">{cap.decision.reason}</div>
          </div>

          {/* Worker count */}
          <div className="min-w-[100px]">
            <Tooltip multiline content={`The next drain pass will spawn ${cap.effectiveJobs} worker${cap.effectiveJobs !== 1 ? "s" : ""} (out of ${cap.maxJobs} configured slots). Workers are one-shot processes — they claim a task, run Claude, then exit. They are NOT always-on background processes.${throttled ? ` Throttled from ${cap.maxJobs} because capacity is low.` : ""}`}>
              <div className="mb-1 cursor-help text-xs font-medium uppercase tracking-wide text-gray-500 underline decoration-dotted">Workers (next drain)</div>
            </Tooltip>
            <div className="font-semibold">
              {cap.effectiveJobs}<span className="text-gray-400">/{cap.maxJobs}</span>
            </div>
            {throttled && (
              <div className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                throttled from {cap.maxJobs}
              </div>
            )}
          </div>

          {/* Mode */}
          <div className="min-w-[120px]">
            <Tooltip
              multiline
              content={
                cap.fleetMode
                  ? "Fleet tiers mode: worker slots are partitioned by model family. Each tier only claims tasks that match its model list. Useful for mixing heavy (Opus) and light (Haiku/Sonnet) workers. Configure tiers in Settings → Fleet tiers. To switch to Flat mode, remove all fleet tiers in Settings."
                  : "Flat mode: all worker slots claim any ready task regardless of the task's model marker. The task's (model:) annotation pins which model the worker will invoke — it does NOT filter which slot picks the task. To switch to Fleet tiers mode, add fleet tier entries in Settings → Fleet tiers."
              }
            >
              <div className="mb-1 cursor-help text-xs font-medium uppercase tracking-wide text-gray-500 underline decoration-dotted">Mode</div>
            </Tooltip>
            <div className="font-medium">{cap.fleetMode ? "Fleet tiers" : "Flat"}</div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              default: <span className="font-mono text-gray-700 dark:text-gray-300">{cap.defaultModel}</span>
            </div>
            <button
              type="button"
              className="mt-1 text-xs text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
              onClick={onGoToSettings}
            >
              {cap.fleetMode ? "Edit tiers ↗" : "Add tiers ↗"}
            </button>
          </div>

          {/* Token buckets */}
          {cap.buckets.length > 0 && (
            <div className="min-w-[120px]">
              <Tooltip multiline content="Claude API token usage across time windows. Drain behavior adapts automatically: below ~40% a throttle kicks in; near 0% the drain pauses entirely. Buckets reset on their own schedule (shown as '·Xh' remaining). Adjust calibration on the Usage tab.">
                <div className="mb-1 cursor-help text-xs font-medium uppercase tracking-wide text-gray-500 underline decoration-dotted">Token capacity</div>
              </Tooltip>
              <div className="space-y-1">
                {cap.buckets.map((b) => {
                  const pct = Math.round(b.fraction * 100);
                  const tone = b.fraction < 0.12 ? "text-red-600" : b.fraction < 0.4 ? "text-amber-600" : "text-emerald-600";
                  return (
                    <Tooltip
                      key={b.key}
                      content={`${BUCKET_FULL_LABELS[b.key] ?? b.key}: ${pct}% remaining (${b.remaining.toLocaleString()} tokens left${b.resetInSeconds != null ? `, resets in ~${Math.round(b.resetInSeconds / 3600)}h` : ""})`}
                    >
                      <div className="flex cursor-help items-center gap-2 text-xs">
                        <span className="w-16 text-gray-500">{BUCKET_LABELS_SHORT[b.key] ?? b.key}</span>
                        <span className={`font-semibold ${tone}`}>{pct}%</span>
                        {b.resetInSeconds != null && (
                          <span className="text-gray-400">·{Math.round(b.resetInSeconds / 3600)}h</span>
                        )}
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Worker slots */}
      <div className={`${CARD_CLASS} mb-2 p-3`}>
        <Tooltip
          multiline
          content={
            cap.fleetMode
              ? "Worker slots allocated by fleet tier. Each slot shows which model(s) it will use when claiming tasks. A slot only picks up tasks that match its model list (or tasks with no model pin in Fleet mode)."
              : "Worker slots in Flat mode. All slots show 'any' — they can claim any ready task regardless of model. The task's (model:) tag tells the worker which model to invoke, but any slot can claim any task."
          }
        >
          <div className="mb-1 cursor-help text-xs font-medium text-gray-500 underline decoration-dotted">
            Worker slots ({cap.maxJobs} configured
            {cap.fleetMode ? " via fleet tiers" : " · flat"})
          </div>
        </Tooltip>
        <div className="flex flex-wrap gap-1.5">
          {cap.workerSlots.map((s) => (
            <Tooltip
              key={s.index}
              content={
                s.models === null
                  ? `Slot w${s.index}: Flat mode — claims any ready task.`
                  : `Slot w${s.index}: Fleet tier — only claims tasks pinned to ${s.models.join(" or ")}.`
              }
            >
              <span
                className="inline-flex cursor-help items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-800"
              >
                <span className="text-gray-400">w{s.index}</span>
                <span className="font-mono">
                  {s.models === null ? <span className="text-gray-500">any</span> : s.models.join(",")}
                </span>
              </span>
            </Tooltip>
          ))}
        </div>
        {!cap.fleetMode && (
          <p className="mt-1.5 text-xs text-gray-400">
            <strong className="text-gray-500">Flat mode:</strong> all slots claim any ready task. A task's{" "}
            <span className="font-mono">(model:)</span> marker tells the worker which model to invoke — it does
            NOT restrict which slot can claim it. Switch to{" "}
            <button type="button" className="underline hover:text-gray-600" onClick={onGoToSettings}>
              Fleet tiers
            </button>{" "}
            to partition slots by model family.
          </p>
        )}
        {cap.fleetMode && (
          <p className="mt-1.5 text-xs text-gray-400">
            <strong className="text-gray-500">Fleet tiers mode:</strong> each slot only claims tasks matching its
            model list. Tasks with no model pin are claimable by any slot.{" "}
            <button type="button" className="underline hover:text-gray-600" onClick={onGoToSettings}>
              Edit tiers ↗
            </button>
          </p>
        )}
      </div>

      {/* Ready task eligibility */}
      <div className={`${CARD_CLASS} p-3`}>
        <DisclosureButton open={readyOpen} onToggle={() => setReadyOpen((o) => !o)} className="mb-2">
          <Tooltip
            multiline
            content="Tasks currently in 'ready' status and eligible for the next drain pass. A task is unclaimable when no worker slot can serve its model requirement (Fleet mode mismatch). Fix by adding the required model to a fleet tier, or switch to Flat mode."
          >
            <div className="cursor-help text-xs font-medium text-gray-500 underline decoration-dotted">
              Ready tasks ({cap.totalReady}
              {cap.unservableReady > 0 && (
                <span className="ml-1 font-semibold text-red-600 dark:text-red-400">
                  · {cap.unservableReady} unclaimable
                </span>
              )}
              )
            </div>
          </Tooltip>
        </DisclosureButton>

        {readyOpen && cap.totalReady === 0 ? (
          <p className="text-xs text-gray-400">No ready tasks — queue is empty or all tasks are blocked/on hold.</p>
        ) : readyOpen ? (
          <div className="space-y-1">
            {cap.readyTasks.map((t) => {
              const canClaim = t.claimableBySlots.length > 0;
              const allSlots = t.claimableBySlots.length === cap.maxJobs;
              return (
                <div
                  key={t.id}
                  className={`flex items-start gap-2 rounded p-2 text-xs ${
                    canClaim ? "bg-gray-50 dark:bg-gray-800/50" : "bg-red-50 dark:bg-red-950/30"
                  }`}
                >
                  <span className="mt-0.5 shrink-0">
                    {canClaim ? (
                      <span className="text-emerald-600 dark:text-emerald-400">✓</span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400">✗</span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="text-gray-400">#{t.id} </span>
                    <span className="font-medium">{t.title}</span>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-gray-500">
                      {/* Model resolution */}
                      <Tooltip
                        content={
                          t.model
                            ? `This task has a (model:${t.model}) pin — the worker will run Claude with that model.`
                            : `No model pin — the worker will use the default model (${t.effectiveModel}).`
                        }
                      >
                        <span className="cursor-help">
                          {t.model ? (
                            <>
                              <span className="font-mono text-accent">{t.model}</span>
                              <span className="text-gray-400"> (pinned)</span>
                            </>
                          ) : (
                            <>
                              <span className="text-gray-400">no pin → </span>
                              <span className="font-mono">{t.effectiveModel}</span>
                              <span className="text-gray-400"> (default)</span>
                            </>
                          )}
                        </span>
                      </Tooltip>
                      {t.repo && <span>{t.repo}</span>}
                      {/* Claimability */}
                      {canClaim ? (
                        allSlots ? (
                          <span className="text-emerald-600 dark:text-emerald-400">
                            claimable by all {cap.maxJobs} slot{cap.maxJobs > 1 ? "s" : ""}
                          </span>
                        ) : (
                          <span className="text-emerald-600 dark:text-emerald-400">
                            claimable by slot{t.claimableBySlots.length > 1 ? "s" : ""}{" "}
                            {t.claimableBySlots.map((i) => `w${i}`).join(", ")}
                          </span>
                        )
                      ) : (
                        <span className="font-medium text-red-600 dark:text-red-400">
                          {t.unclaimableReason}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {readyOpen && cap.maxJobs > 0 && cap.totalReady > 0 && cap.totalReady < cap.maxJobs && (
          <p className="mt-2 text-xs text-gray-400">
            {cap.totalReady} ready task{cap.totalReady > 1 ? "s" : ""} · {cap.maxJobs} slots — only{" "}
            {cap.totalReady} worker{cap.totalReady > 1 ? "s" : ""} will run (others exit idle immediately).
            Workers are per-drain-pass processes, not always-on daemons.
          </p>
        )}
      </div>
    </section>
  );
}

/** Small status dot with label. */
function StatusDot({
  on,
  label,
  color,
}: {
  on: boolean;
  label: string;
  color: "emerald" | "accent" | "amber" | "gray";
}) {
  const dotColor = on
    ? color === "accent"
      ? "bg-accent"
      : color === "emerald"
        ? "bg-emerald-500 dark:bg-emerald-400"
        : color === "amber"
          ? "bg-amber-500 dark:bg-amber-400"
          : "bg-gray-400"
    : "bg-gray-300 dark:bg-gray-600";
  const textColor =
    color === "accent"
      ? "text-accent"
      : color === "emerald"
        ? "text-emerald-600 dark:text-emerald-400"
        : color === "amber"
          ? "text-amber-600 dark:text-amber-400"
          : "text-gray-400";
  return (
    <span className={`flex items-center gap-1.5 text-xs ${on ? textColor : "text-gray-400"}`}>
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
      {label}
    </span>
  );
}

/** Drainer status + control (replaces the old Watchdog tab). */
function DrainerControl({ onGoToSettings }: { onGoToSettings: () => void }) {
  const { data } = useQuery({ queryKey: ["taskq-drainer"], queryFn: fetchTaskqDrainer, refetchInterval: 5000 });
  const configQ = useQuery({ queryKey: ["taskq-config"], queryFn: fetchTaskqConfig });
  const { data: cap } = useQuery({ queryKey: ["taskq-capacity"], queryFn: fetchTaskqCapacity, refetchInterval: 8000 });
  const { data: recentRuns } = useQuery({ queryKey: ["taskq-drain-runs-1"], queryFn: () => fetchTaskqDrainRuns(1), refetchInterval: 5000 });
  const qc = useQueryClient();
  const { notify } = useToast();
  const run = useMutation({
    mutationFn: runTaskqDrainer,
    onSuccess: (r) => {
      qc.setQueryData(["taskq-drainer"], r.status);
      notify("Drain pass started", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "failed", "error"),
  });
  const stop = useMutation({
    mutationFn: stopTaskqDrainer,
    onSuccess: (r) => {
      qc.setQueryData(["taskq-drainer"], r.status);
      notify("Graceful stop set — workers finish their current task, then exit", "success");
    },
  });
  const resume = useMutation({
    mutationFn: resumeTaskqDrainer,
    onSuccess: (r) => {
      qc.setQueryData(["taskq-drainer"], r.status);
      notify("Resumed — workers will claim new tasks on the next drain", "success");
    },
  });
  const watchdog = useMutation({
    mutationFn: (action: "load" | "unload") => setTaskqWatchdog(action),
    onSuccess: (r, action) => {
      qc.invalidateQueries({ queryKey: ["taskq-drainer"] });
      notify(
        r.ok
          ? action === "load"
            ? "Watchdog loaded — drain passes will fire automatically on the tick interval"
            : "Watchdog unloaded — no more automatic drain ticks (you can still run manually)"
          : r.out || "failed",
        r.ok ? "success" : "error",
      );
    },
    onError: (e) => notify(e instanceof Error ? e.message : "failed", "error"),
  });
  const [lastHeal, setLastHeal] = useState<HealerResult | null>(null);
  const heal = useMutation({
    mutationFn: runTaskqHealer,
    onSuccess: (r) => {
      setLastHeal(r);
      if (r.issuesFound === 0) {
        notify("Environment healthy — no stall issues detected", "success");
      } else if (r.issuesFixed === r.issuesFound) {
        notify(`Healed ${r.issuesFixed} stall issue${r.issuesFixed === 1 ? "" : "s"}`, "success");
      } else {
        notify(
          `Found ${r.issuesFound} issue${r.issuesFound === 1 ? "" : "s"}, fixed ${r.issuesFixed}`,
          "warning",
        );
      }
    },
    onError: (e) => notify(e instanceof Error ? e.message : "healer failed", "error"),
  });

  const s = data;
  const interval = configQ.data?.interval ?? null;

  // Track the first moment we see the watchdog loaded — used as a countdown anchor
  // when lastFireMs is null (watchdog just loaded, drain hasn't fired yet this session).
  const firstLoadedAt = useRef<number | null>(null);
  useEffect(() => {
    if (s?.watchdogLoaded) {
      if (firstLoadedAt.current === null) firstLoadedAt.current = Date.now();
    } else {
      firstLoadedAt.current = null;
    }
  }, [s?.watchdogLoaded]);

  // Live countdown to the next scheduled tick.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const nextFireAt =
    s?.lastFireMs != null && interval != null
      ? s.lastFireMs + interval * 1000
      : firstLoadedAt.current != null && interval != null
        ? firstLoadedAt.current + interval * 1000
        : null;
  const msUntilNext = nextFireAt != null ? Math.max(0, nextFireAt - now) : null;
  const nextFireTime = nextFireAt != null ? new Date(nextFireAt).toLocaleTimeString() : null;
  const lastRun = recentRuns?.[0] ?? null;

  return (
    <div className={`${CARD_CLASS} mb-3 p-3`}>
      {/* Status row */}
      <div className="mb-3 flex flex-wrap items-start gap-6">
        {/* Scheduler section */}
        <div className="min-w-[180px]">
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-500">Scheduler</div>
          <Tooltip
            multiline
            content={
              s?.watchdogLoaded
                ? `The launchd watchdog agent (com.taskq.drain) is loaded and active. It automatically fires a drain pass every ${interval != null ? fmtIntervalSec(interval) : "tick"} — even when no browser window is open. Unload it to stop automatic draining (you can still trigger runs manually).`
                : "The launchd watchdog agent is NOT loaded — drain passes only run when you click 'Run once'. Load it to enable automatic periodic draining on a background timer."
            }
          >
            <StatusDot
              on={!!s?.watchdogLoaded}
              label={s?.watchdogLoaded ? "Watchdog loaded" : "Watchdog off"}
              color={s?.watchdogLoaded ? "emerald" : "gray"}
            />
          </Tooltip>
          {s?.watchdogLoaded && interval != null && (
            <div className="mt-1 text-xs text-gray-400">
              fires every{" "}
              <Tooltip content={`launchd StartInterval = ${interval}s. Change this in Settings → Watchdog. Reload is required for the new interval to take effect.`}>
                <span className="cursor-help border-b border-dotted border-gray-400 font-medium text-gray-600 dark:text-gray-300">
                  {fmtIntervalSec(interval)}
                </span>
              </Tooltip>
            </div>
          )}
          {/* Last fired */}
          <div className="mt-1.5 space-y-0.5 text-xs text-gray-400">
            {s?.lastFireMs != null ? (
              <Tooltip
                content={
                  s?.running
                    ? `Drain active — heartbeat at ${new Date(s.lastFireMs).toLocaleString()}. While a pass runs it re-stamps every tick (it can run for many minutes on long tasks), so this stays fresh instead of freezing at the start time.`
                    : `Last drain tick at ${new Date(s.lastFireMs).toLocaleString()}`
                }
              >
                <div className="cursor-help">
                  {s?.running ? "heartbeat" : "last fired"}{" "}
                  <span className="font-medium text-gray-600 dark:text-gray-300">
                    {fmtTimeAgo(s.lastFireMs, now)}
                  </span>
                  {" "}at{" "}
                  <span className="font-medium text-gray-600 dark:text-gray-300">
                    {new Date(s.lastFireMs).toLocaleTimeString()}
                  </span>
                </div>
              </Tooltip>
            ) : s?.watchdogLoaded ? (
              <div>last fired: <span className="text-gray-500">not yet this session</span></div>
            ) : null}
            {/* Countdown to next fire — only meaningful while idle; a running drain
                heartbeats instead of re-firing (launchd coalesces while it's alive). */}
            {!s?.running && s?.watchdogLoaded && interval != null && nextFireAt != null && (
              <div>
                next in{" "}
                <span className="font-medium text-gray-600 dark:text-gray-300">
                  {msUntilNext != null && msUntilNext > 0 ? fmtDur(msUntilNext) : "now"}
                </span>
                {" "}at{" "}
                <span className="font-medium text-gray-600 dark:text-gray-300">{nextFireTime}</span>
              </div>
            )}
            {/* Last run result */}
            {lastRun != null && (
              <Tooltip
                multiline
                content={`Drain at ${new Date(lastRun.started_at).toLocaleTimeString()}: ${lastRun.reason}${lastRun.completed != null && lastRun.completed > 0 ? ` · ${lastRun.completed} task${lastRun.completed === 1 ? "" : "s"} completed` : ""}${lastRun.failed != null && lastRun.failed > 0 ? ` · ${lastRun.failed} failed` : ""}${lastRun.reaped != null && lastRun.reaped > 0 ? ` · ${lastRun.reaped} reaped` : ""}`}
              >
                <div className="cursor-help">
                  last run:{" "}
                  <span className={`font-medium ${lastRunColor(lastRun.decision)}`}>
                    {lastRunSummary(lastRun)}
                  </span>
                </div>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Active drain section */}
        <div className="min-w-[160px]">
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-500">Active drain</div>
          <Tooltip
            multiline
            content={
              s?.running
                ? "A taskqDrain process is actively running right now — it is claiming ready tasks and spawning Claude workers. This state is ephemeral: the process starts, works through the queue, and exits. The watchdog scheduler (if loaded) will restart it on the next tick."
                : cap?.decision.preferLight
                  ? `No drain is running. Token capacity is low (${cap.decision.reason}) — each watchdog tick will run 1 light-model worker. Tasks that succeed will auto-recalibrate the bucket estimate.`
                  : "No drain is running right now. The queue is idle. If the watchdog is loaded, a new drain pass will start automatically on the next scheduler tick. You can also trigger one immediately with 'Run once'."
            }
          >
            <StatusDot
              on={!!s?.running}
              label={s?.running ? "Draining now" : cap?.decision.preferLight ? "Idle (throttled)" : "Idle"}
              color={s?.running ? "accent" : cap?.decision.preferLight ? "amber" : "gray"}
            />
          </Tooltip>
          {s?.running && (
            <div className="mt-1 text-xs text-gray-400">workers are claiming tasks</div>
          )}
        </div>

        {/* Stop sentinel section */}
        {s?.stopped && (
          <div className="min-w-[120px]">
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-500">Stop signal</div>
            <Tooltip
              multiline
              content="The graceful-stop sentinel (.stop file in ~/.taskq/) is set. Running workers will finish their current task and then exit — no new tasks are claimed. The watchdog will still fire ticks but the drain will exit early when it sees this file. Click 'Resume' to clear it and let workers claim tasks again."
            >
              <StatusDot on={true} label="Stop sentinel set" color="amber" />
            </Tooltip>
          </div>
        )}
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Drain controls */}
        <Tooltip content="Spawn a drain pass right now. Clears the stop sentinel first. Workers start immediately, claim ready tasks, and exit when the queue is empty or all slots are filled.">
          <button
            type="button"
            className={BTN_GHOST_CLASS}
            onClick={() => run.mutate()}
            disabled={run.isPending || !!s?.running}
          >
            {run.isPending && <Spinner />}
            Run once
          </button>
        </Tooltip>

        {s?.stopped ? (
          <Tooltip content="Clear the graceful-stop sentinel so workers can claim new tasks on the next drain pass.">
            <button
              type="button"
              className={BTN_GHOST_CLASS}
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
            >
              {resume.isPending && <Spinner />}
              Resume
            </button>
          </Tooltip>
        ) : (
          <Tooltip
            multiline
            content="Set the graceful-stop sentinel. Running workers finish their current task and then exit without picking up anything new. The queue is preserved — nothing is lost. Use this to pause draining gracefully without interrupting in-flight work."
          >
            <button
              type="button"
              className={BTN_GHOST_CLASS}
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
            >
              {stop.isPending && <Spinner />}
              Graceful stop
            </button>
          </Tooltip>
        )}

        {/* Watchdog load/unload */}
        <div className="ml-1 border-l border-gray-200 pl-3 dark:border-gray-700">
          {s?.watchdogLoaded ? (
            <Tooltip content="Unload the launchd watchdog agent. Automatic drain ticks stop immediately. You can still trigger drains manually with 'Run once'. Reload in Settings → Watchdog to re-enable.">
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                onClick={() => watchdog.mutate("unload")}
                disabled={watchdog.isPending}
              >
                {watchdog.isPending && <Spinner />}
                Unload watchdog
              </button>
            </Tooltip>
          ) : (
            <Tooltip content="Load the launchd watchdog agent. It will run drain passes automatically on the configured tick interval. Configure the interval and other settings in Settings.">
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                onClick={() => watchdog.mutate("load")}
                disabled={watchdog.isPending}
              >
                {watchdog.isPending && <Spinner />}
                Load watchdog
              </button>
            </Tooltip>
          )}
        </div>

        {/* Self-healer: detect + fix stalled drain states */}
        <div className="ml-1 border-l border-gray-200 pl-3 dark:border-gray-700">
          <Tooltip
            multiline
            content="Detect and fix stalled orchestration states: rebuild cwip dist if missing, relink first-party symlinks, restart a stalled drain, and reap expired leases. Safe to run any time."
          >
            <button
              type="button"
              className={BTN_GHOST_CLASS}
              onClick={() => heal.mutate()}
              disabled={heal.isPending}
            >
              {heal.isPending && <Spinner />}
              Self-heal
            </button>
          </Tooltip>
        </div>

        <button
          type="button"
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          onClick={onGoToSettings}
        >
          Configure in Settings ↗
        </button>
      </div>

      {/* Healer result — shown after a manual run */}
      {lastHeal && (
        <HealerResultPanel result={lastHeal} onDismiss={() => setLastHeal(null)} />
      )}
    </div>
  );
}

/** Compact display of the last self-healer run result. */
function HealerResultPanel({ result, onDismiss }: { result: HealerResult; onDismiss: () => void }) {
  const tone = result.issuesFound === 0 ? "success" : result.issuesFixed === result.issuesFound ? "success" : "warning";
  return (
    <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-700">
      <div className="mb-1 flex items-center gap-2">
        <span className={`text-xs font-semibold ${tone === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
          {result.issuesFound === 0
            ? "Environment healthy"
            : `${result.issuesFound} issue${result.issuesFound === 1 ? "" : "s"} found, ${result.issuesFixed} fixed`}
        </span>
        {result.inconclusive && (
          <span className="text-xs text-gray-400">(some checks inconclusive)</span>
        )}
        <button
          type="button"
          className="ml-auto text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          onClick={onDismiss}
        >
          ✕
        </button>
      </div>
      {result.issues.length > 0 && (
        <ul className="space-y-1">
          {result.issues.map((issue, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className={issue.fixed ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                {issue.fixed ? "✓" : "!"}
              </span>
              <span className="text-gray-600 dark:text-gray-300">{issue.description}</span>
              {issue.detail && (
                <span className="text-gray-400">{issue.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtIntervalSec(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

function fmtTimeAgo(epochMs: number, now: number): string {
  const ms = now - epochMs;
  if (ms < 5000) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function lastRunSummary(run: TaskqDrainRun): string {
  const completed = run.completed ?? 0;
  const failed = run.failed ?? 0;
  if (run.decision === "paused") return "paused";
  if (run.decision === "stopped") return "stopped";
  if (run.decision === "throttled") {
    return completed > 0 ? `throttled · ${completed} done` : "throttled · no tasks";
  }
  if (completed > 0) return `${completed} task${completed === 1 ? "" : "s"} done${failed > 0 ? ` · ${failed} failed` : ""}`;
  if (failed > 0) return `${failed} failed`;
  return "no tasks found";
}

function lastRunColor(decision: string): string {
  if (decision === "paused" || decision === "stopped") return "text-amber-600 dark:text-amber-400";
  if (decision === "throttled") return "text-amber-600 dark:text-amber-400";
  return "text-gray-600 dark:text-gray-300";
}

/** Live worker instances (current leases) + per-instance release. */
function InstancesPanel() {
  const { data } = useQuery({ queryKey: ["taskq-instances"], queryFn: fetchTaskqInstances, refetchInterval: 4000 });
  const configQ = useQuery({ queryKey: ["taskq-config"], queryFn: fetchTaskqConfig });
  const defaultModel = configQ.data?.config?.model ?? 'sonnet';
  const qc = useQueryClient();
  const { notify } = useToast();
  const [open, setOpen] = useState(true);
  const release = useMutation({
    mutationFn: (id: number) => releaseTaskqInstance(id),
    onSuccess: (r) => {
      qc.setQueryData(["taskq-instances"], { instances: r.instances });
      qc.setQueryData(["taskq"], r.board);
      notify("Released → ready", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "release failed", "error"),
  });
  const allItems = data?.instances ?? [];
  const now = Date.now();
  // Only show tasks that a worker is ACTIVELY running. Group-claimed tasks have
  // heartbeat_at == claimed_at until the drain starts working on them; filter those
  // out so "Live instances (N)" reports actual running workers, not all leases.
  const HEARTBEAT_GRACE_MS = 30_000;
  const items = allItems.filter(
    (i) => i.heartbeat_at == null || i.claimed_at == null || i.heartbeat_at > i.claimed_at + HEARTBEAT_GRACE_MS,
  );
  const groupQueued = allItems.length - items.length;
  return (
    <section>
      <button
        type="button"
        className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`text-xs transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        Active workers <span className="text-gray-400">({items.length})</span>
        {groupQueued > 0 && (
          <span className="ml-1 text-xs font-normal text-gray-400">
            +{groupQueued} group-queued
          </span>
        )}
      </button>
      {open && items.length === 0 ? (
        <p className="text-sm text-gray-400">No workers active right now{groupQueued > 0 ? ` (${groupQueued} group-queued on deck)` : ""}.</p>
      ) : open ? (
        <div className="space-y-3">
          {items.map((i) => {
            const elapsed = now - i.claimed_at;
            const hbAgo = now - i.heartbeat_at;
            const leaseExpired = now > i.expires_at;
            const expiresIn = i.expires_at - now;
            const hbStale = hbAgo > 120_000;
            return (
              <div key={i.task_id} className={`${CARD_CLASS} p-3`}>
                {/* Header: running indicator + task title + elapsed badge + release */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="relative mt-0.5 flex h-2 w-2 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                    </span>
                    <p className="min-w-0 truncate text-sm font-semibold">
                      <span className="mr-1 font-normal text-gray-400">#{i.task_id}</span>
                      {i.title}
                    </p>
                    <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                      {fmtDur(elapsed)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={`${BTN_GHOST_CLASS} shrink-0 text-xs`}
                    disabled={release.isPending}
                    onClick={() => release.mutate(i.task_id)}
                  >
                    Release
                  </button>
                </div>

                {/* Detail grid */}
                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
                  <WorkerInfoCell label="Model">
                    <span className="font-mono font-medium text-accent">
                      {i.model ?? defaultModel}
                    </span>
                  </WorkerInfoCell>

                  <WorkerInfoCell label="Think">
                    <span className={
                      i.think === "high" || i.think === "max"
                        ? "font-medium text-violet-600 dark:text-violet-400"
                        : i.think && i.think !== "off"
                          ? "text-gray-700 dark:text-gray-200"
                          : "text-gray-400"
                    }>
                      {i.think || "off"}
                    </span>
                    {!!i.fast && (
                      <span className="ml-1.5 rounded bg-blue-100 px-1 py-0.5 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                        fast
                      </span>
                    )}
                  </WorkerInfoCell>

                  <WorkerInfoCell label="Started">
                    <span className="text-gray-700 dark:text-gray-200">{fmtTs(i.claimed_at)}</span>
                  </WorkerInfoCell>

                  <WorkerInfoCell label="Lease">
                    {leaseExpired ? (
                      <span className="font-medium text-red-600 dark:text-red-400">
                        expired {fmtDur(now - i.expires_at)} ago
                      </span>
                    ) : (
                      <span className={expiresIn < 300_000 ? "font-medium text-amber-600 dark:text-amber-400" : "text-gray-600 dark:text-gray-300"}>
                        {fmtDur(expiresIn)} left
                      </span>
                    )}
                  </WorkerInfoCell>

                  <WorkerInfoCell label="Heartbeat">
                    <span className={hbStale ? "font-medium text-amber-600 dark:text-amber-400" : "text-gray-600 dark:text-gray-300"}>
                      {hbStale && "⚠ "}{fmtDur(hbAgo)} ago
                    </span>
                  </WorkerInfoCell>

                  {i.repo && (
                    <WorkerInfoCell label="Repo">
                      <span className="font-mono text-gray-700 dark:text-gray-200">{i.repo}</span>
                    </WorkerInfoCell>
                  )}

                  {i.slug && (
                    <WorkerInfoCell label="Id">
                      <span className="font-mono text-gray-600 dark:text-gray-300">{i.slug}</span>
                    </WorkerInfoCell>
                  )}

                  {i.group_key && (
                    <WorkerInfoCell label="Group">
                      <span className="font-mono text-gray-600 dark:text-gray-300">{i.group_key}</span>
                    </WorkerInfoCell>
                  )}

                  <WorkerInfoCell label="Worker" wide>
                    <span className="break-all font-mono text-gray-600 dark:text-gray-300">{i.worker_id}</span>
                  </WorkerInfoCell>

                  {i.worktree && (
                    <WorkerInfoCell label="Worktree" wide>
                      <span className="break-all font-mono text-gray-500 dark:text-gray-400">
                        {i.worktree.replace(/^\/Users\/[^/]+/, "~")}
                      </span>
                    </WorkerInfoCell>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {open && (
        <p className="mt-2 text-xs text-gray-400">
          Release returns a task to "ready" (drops the lease). To stop ALL work, use Graceful stop above. To cap how
          many run at once, set Jobs / fleet tiers in Settings.
        </p>
      )}
    </section>
  );
}

function WorkerInfoCell({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2 sm:col-span-3" : ""}>
      <div className="mb-0.5 text-gray-400">{label}</div>
      <div>{children}</div>
    </div>
  );
}

/** Structured drain history + raw watchdog log. */
function DrainRunsPanel() {
  const { data: runs } = useQuery({ queryKey: ["taskq-drain-runs"], queryFn: () => fetchTaskqDrainRuns(30), refetchInterval: 5000 });
  const { data: logs } = useQuery({ queryKey: ["taskq-logs"], queryFn: () => fetchTaskqLogs(200), refetchInterval: 5000 });
  const [open, setOpen] = useState(true);

  function fmtRunTs(epochMs: number): string {
    const d = new Date(epochMs);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  function decisionBadge(decision: string) {
    const map: Record<string, { label: string; cls: string }> = {
      normal:    { label: 'Normal',    cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
      paused:    { label: 'Paused',    cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
      throttled: { label: 'Throttled', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
      burning:   { label: 'Burning',   cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
      stopped:   { label: 'Stopped',   cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
    };
    const d = map[decision] ?? { label: decision, cls: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300' };
    return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${d.cls}`}>{d.label}</span>;
  }

  const items: TaskqDrainRun[] = runs ?? [];

  return (
    <section>
      <button
        type="button"
        className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`text-xs transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        Drain history {items.length > 0 && <span className="text-gray-400">({items.length})</span>}
      </button>
      {open && items.length === 0 ? (
        <p className="text-sm text-gray-400">No drain runs recorded yet — runs will appear here after the next drain tick.</p>
      ) : open ? (
        <>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-gray-500 dark:border-gray-700 dark:bg-gray-800/60">
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Decision</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                  <th className="px-3 py-2 font-medium">Workers</th>
                  <th className="px-3 py-2 font-medium">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                {items.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-gray-600 dark:text-gray-300">
                      {fmtRunTs(r.started_at)}
                    </td>
                    <td className="px-3 py-2">{decisionBadge(r.decision)}</td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{r.reason}</td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                      {r.decision === 'paused' ? '—' : `${r.jobs}/${r.max_jobs}`}
                    </td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                      {r.completed ? <span className="font-medium text-emerald-600 dark:text-emerald-400">{r.completed}</span> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="mt-3">
            <summary className="cursor-pointer select-none text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
              Raw watchdog log
            </summary>
            <div className="mt-2">
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-950 p-3 text-xs text-gray-300">
                {(logs?.lines ?? []).join("\n") || "(empty)"}
              </pre>
              {logs?.path && <p className="mt-1 font-mono text-xs text-gray-400">{logs.path}</p>}
            </div>
          </details>
        </>
      ) : null}
    </section>
  );
}

/** Settings: drainer/watchdog config + fleet tiers + launchd control. */
function SettingsPanel() {
  const { data } = useQuery({ queryKey: ["taskq-config"], queryFn: fetchTaskqConfig });
  const status = useQuery({ queryKey: ["taskq-drainer"], queryFn: fetchTaskqDrainer, refetchInterval: 5000 });
  if (!data) return <p className="text-gray-400">loading…</p>;
  return <ConfigForm config={data.config} interval={data.interval} watchdogLoaded={!!status.data?.watchdogLoaded} />;
}

function ConfigForm({ config, interval, watchdogLoaded }: { config: TaskqConfig; interval: number; watchdogLoaded: boolean }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const [jobs, setJobs] = useState(config.jobs);
  const [model, setModel] = useState(config.model);
  const [think, setThink] = useState(config.think ?? "");
  const [fast, setFast] = useState(!!config.fast);
  const [throttle, setThrottle] = useState(!!config.throttle);
  const [ttlMin, setTtlMin] = useState(Math.round(config.leaseTtlMs / 60000));
  const [timeoutMin, setTimeoutMin] = useState(Math.round(config.taskTimeoutMs / 60000));
  const [triage, setTriage] = useState(!!config.triage?.enabled);
  const [fleet, setFleet] = useState<TaskqFleetTier[]>(config.fleet ?? []);
  const [intervalS, setIntervalS] = useState(interval);

  const save = useMutation({
    mutationFn: () => {
      const patch: TaskqConfigPatch = {
        jobs,
        model,
        think,
        fast,
        throttle,
        leaseTtlMs: ttlMin * 60000,
        taskTimeoutMs: timeoutMin * 60000,
        triageEnabled: triage,
        fleet: fleet.length ? fleet : null,
      };
      return saveTaskqConfig(patch);
    },
    onSuccess: (r) => {
      qc.setQueryData(["taskq-config"], r);
      notify("Settings saved (applies on the next drain)", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });
  const watchdog = useMutation({
    mutationFn: (a: "load" | "unload") => setTaskqWatchdog(a),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["taskq-drainer"] });
      notify(r.ok ? "Watchdog updated" : r.out || "failed", r.ok ? "success" : "error");
    },
  });
  const setIntv = useMutation({
    mutationFn: () => setTaskqInterval(intervalS),
    onSuccess: (r) => notify(r.ok ? "Interval set" : r.out || "failed", r.ok ? "success" : "error"),
    onError: (e) => notify(e instanceof Error ? e.message : "failed", "error"),
  });

  return (
    <div className="max-w-2xl space-y-6">
      {/* Worker pool */}
      <section className={`${CARD_CLASS} p-4`}>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Worker pool</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label={`Max instances (jobs): ${jobs}`}
            hint="Max concurrent workers per drain pass (Flat mode). Overridden by fleet tiers if any are configured."
          >
            <input type="range" min={1} max={16} value={jobs} onChange={(e) => setJobs(Number(e.target.value))} className="w-full" />
          </Field>
          <Field label="Default model" hint="Model passed to 'claude -p' when a task has no (model:) pin. Overridden per-task by (model:opus), (model:sonnet), etc.">
            <select className={FIELD_CLASS} value={model} onChange={(e) => setModel(e.target.value)}>
              {TASKQ_MODEL_ALIASES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Default thinking" hint="Extended thinking level for workers with no (think:) task pin. 'off' = no extended thinking. Higher levels use more tokens.">
            <select className={FIELD_CLASS} value={think} onChange={(e) => setThink(e.target.value)}>
              <option value="">off / unset</option>
              {TASKQ_THINK_LEVELS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Lease TTL (min)" hint="A worker must heartbeat within this window or its lease is reaped and the task is returned to 'ready' for retry.">
            <input type="number" min={1} className={FIELD_CLASS} value={ttlMin} onChange={(e) => setTtlMin(Number(e.target.value))} />
          </Field>
          <Field label="Task timeout (min)" hint="Hard ceiling on one worker's 'claude -p' run. A hung agent keeps heartbeating, so the lease never expires — this kills it so the task fails, the worker frees up, and the queue keeps flowing (a hang can otherwise wedge the whole drain).">
            <input type="number" min={1} max={1440} className={FIELD_CLASS} value={timeoutMin} onChange={(e) => setTimeoutMin(Number(e.target.value))} />
          </Field>
          <Tooltip content="Pass --fast to 'claude -p', enabling fast mode (Opus with faster output). Uses more tokens per session. Can be overridden per-task with (fast:) markers.">
            <label className="flex cursor-help items-center gap-2 text-sm">
              <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} className="h-4 w-4" />
              Fast mode default
            </label>
          </Tooltip>
          <Tooltip multiline content="When enabled, the drain checks new tasks with no description and auto-grades them (assigns a model/think level) and decomposes any epics into subtasks before claiming. Adds a brief triage pass before the main drain.">
            <label className="flex cursor-help items-center gap-2 text-sm">
              <input type="checkbox" checked={triage} onChange={(e) => setTriage(e.target.checked)} className="h-4 w-4" />
              Auto-triage (grade blank tasks + decompose epics)
            </label>
          </Tooltip>
          <Tooltip multiline content="Throttle: shrink the worker pool toward 1 light-model worker as token limits approach (the old adaptive behavior). OFF (default) = MAXIMIZE: always run the full jobs/fleet pool — a lockout rejects calls without charging, so the full pool costs nothing extra and the per-task limit-backoff (not a shrinking pool) absorbs limits. Throttle by lowering Jobs, or turn this on.">
            <label className="flex cursor-help items-center gap-2 text-sm">
              <input type="checkbox" checked={throttle} onChange={(e) => setThrottle(e.target.checked)} className="h-4 w-4" />
              Throttle pool on low capacity {throttle ? "" : "(off → maximize)"}
            </label>
          </Tooltip>
        </div>
      </section>

      {/* Fleet tiers */}
      <section className={`${CARD_CLASS} p-4`}>
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-gray-500">Fleet tiers</h3>
        <p className="mb-3 text-xs text-gray-400">
          Per-model worker pools — overrides the flat Jobs setting above.{" "}
          <strong className="text-gray-500">Flat mode</strong> (no tiers): all slots claim any task, the task's{" "}
          <span className="font-mono">(model:)</span> tag just picks the model.{" "}
          <strong className="text-gray-500">Fleet mode</strong> (has tiers): each tier gets a dedicated pool that
          only claims tasks matching its model list. Useful for mixing Opus/Sonnet/Haiku workers. Each tier entry
          shows as a labeled slot in Workers → Drain capacity. Remove all tiers to return to Flat mode.
        </p>
        <div className="space-y-2">
          {fleet.map((tier, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className={`${FIELD_CLASS} flex-1`}
                placeholder="models e.g. sonnet,haiku"
                value={tier.models.join(",")}
                onChange={(e) => setFleet((f) => f.map((t, j) => (j === i ? { ...t, models: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : t)))}
              />
              <input
                type="number"
                min={1}
                max={16}
                className={`${FIELD_CLASS} w-20`}
                value={tier.jobs}
                onChange={(e) => setFleet((f) => f.map((t, j) => (j === i ? { ...t, jobs: Number(e.target.value) } : t)))}
              />
              <button type="button" className={BTN_GHOST_CLASS} onClick={() => setFleet((f) => f.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => setFleet((f) => [...f, { models: ["sonnet"], jobs: 1 }])}>
            + Add tier
          </button>
        </div>
      </section>

      <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending && <Spinner />}Save settings
      </button>

      {/* Watchdog (launchd) */}
      <section className={`${CARD_CLASS} p-4`}>
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-gray-500">Watchdog (launchd)</h3>
        <p className="mb-3 text-xs text-gray-400">
          The launchd agent (<span className="font-mono">com.taskq.drain</span>) fires drain passes automatically
          on a timer. When loaded, it runs even when no browser window is open. Loading writes a plist to{" "}
          <span className="font-mono">~/Library/LaunchAgents/</span> and registers it with launchd.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Tooltip
            content={
              watchdogLoaded
                ? "The launchd agent is loaded and will fire drain passes automatically on the configured tick interval."
                : "The launchd agent is not loaded. Drain passes will only run when triggered manually."
            }
          >
            <Badge tone={watchdogLoaded ? "success" : "neutral"}>{watchdogLoaded ? "loaded" : "not loaded"}</Badge>
          </Tooltip>
          {watchdogLoaded ? (
            <Tooltip content="Unload the launchd agent. Automatic drain ticks will stop. You can still run drains manually from the Workers tab.">
              <button type="button" className={BTN_GHOST_CLASS} onClick={() => watchdog.mutate("unload")} disabled={watchdog.isPending}>
                {watchdog.isPending && <Spinner />}
                Unload
              </button>
            </Tooltip>
          ) : (
            <Tooltip content="Load (or reload) the launchd agent with the current tick interval. The agent will start firing drain passes automatically.">
              <button type="button" className={BTN_GHOST_CLASS} onClick={() => watchdog.mutate("load")} disabled={watchdog.isPending}>
                {watchdog.isPending && <Spinner />}
                Load
              </button>
            </Tooltip>
          )}
          <Tooltip content="How often launchd fires a drain pass, in seconds. Minimum 30s. After changing, click 'Set interval' — this rewrites the plist and reloads the agent.">
            <span className="text-sm text-gray-500">Tick every</span>
          </Tooltip>
          <input
            type="number"
            min={30}
            className={`${FIELD_CLASS} w-24`}
            value={intervalS}
            onChange={(e) => setIntervalS(Number(e.target.value))}
          />
          <span className="text-sm text-gray-500">s</span>
          <Tooltip content="Rewrite the plist with the new tick interval and reload the launchd agent. Takes effect immediately.">
            <button type="button" className={BTN_GHOST_CLASS} onClick={() => setIntv.mutate()} disabled={setIntv.isPending}>
              {setIntv.isPending && <Spinner />}
              Set interval
            </button>
          </Tooltip>
        </div>
      </section>

      {/* Effective state + paths */}
      <section className={`${CARD_CLASS} p-4 text-xs`}>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Current effective settings</h3>
        <pre className="overflow-auto whitespace-pre-wrap text-gray-600 dark:text-gray-300">{JSON.stringify(config, null, 2)}</pre>
      </section>
    </div>
  );
}

/** Completed-task history + simple stats (from the completions table). */
function HistoryPanel() {
  const { data } = useQuery({ queryKey: ["taskq-history"], queryFn: fetchTaskqHistory, refetchInterval: 10000 });
  const [detail, setDetail] = useState<(typeof recent)[0] | null>(null);
  const recent = data?.recent ?? [];
  if (recent.length === 0) return <p className="text-sm text-gray-400">No completed tasks yet.</p>;
  const totalMins = Math.round((data?.stats.totalDurationS ?? 0) / 60);
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        History <span className="text-gray-400">({data?.stats.total} done · {totalMins}m total)</span>
      </h3>
      <div className="space-y-1">
        {recent.map((c) => {
          const durMins = c.duration_s != null ? Math.round(c.duration_s / 60) : null;
          return (
            <button
              key={`${c.task_id}-${c.ended_at}`}
              type="button"
              onClick={() => setDetail(c)}
              className={`${CARD_CLASS} flex w-full cursor-pointer items-start justify-between gap-3 p-2 text-left text-xs hover:ring-1 hover:ring-accent/30`}
            >
              <span className="min-w-0 flex-1">
                <span className="mr-1 text-gray-400">#{c.task_id}</span>
                <span className="font-medium">{c.title}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-gray-400">
                  {c.started_at != null && <span>start {fmtTs(c.started_at)}</span>}
                  <span>end {fmtTs(c.ended_at)}</span>
                  {durMins != null && <span>{durMins}m</span>}
                </span>
              </span>
              <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                {c.repo && <Badge tone="neutral">{c.repo}</Badge>}
                {c.model && (
                  <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-xs text-accent">{c.model}</span>
                )}
                {c.think && c.think !== "off" && (
                  <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                    think:{c.think}
                  </span>
                )}
                {!!c.fast && (
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                    fast
                  </span>
                )}
                {c.commit && <span className="font-mono text-gray-500">{c.commit.slice(0, 7)}</span>}
              </span>
            </button>
          );
        })}
      </div>

      {detail && (
        <HistoryDetailModal
          completion={detail}
          onClose={() => setDetail(null)}
        />
      )}
    </section>
  );
}

function HistoryDetailModal({
  completion: c,
  onClose,
}: {
  completion: {
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
  };
  onClose: () => void;
}) {
  const durMins = c.duration_s != null ? `${Math.round(c.duration_s / 60)}m` : null;
  const durExact = c.duration_s != null ? `${c.duration_s}s` : null;
  return (
    <ModalShell size="lg" title={`Task #${c.task_id}`} subtitle={c.title} onClose={onClose}>
      <div className="space-y-4">
        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <DetailCell label="Status">
            <Badge tone="success">done</Badge>
          </DetailCell>
          {c.repo && (
            <DetailCell label="Repo">
              <span className="font-mono">{c.repo}</span>
            </DetailCell>
          )}
          {c.model && (
            <DetailCell label="Model">
              <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-xs text-accent">{c.model}</span>
            </DetailCell>
          )}
          {c.think && c.think !== "off" && (
            <DetailCell label="Thinking">
              <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                {c.think}
              </span>
            </DetailCell>
          )}
          {!!c.fast && (
            <DetailCell label="Fast mode">
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                on
              </span>
            </DetailCell>
          )}
          {c.started_at != null && (
            <DetailCell label="Started">
              <span className="text-gray-700 dark:text-gray-200">{fmtTs(c.started_at)}</span>
            </DetailCell>
          )}
          <DetailCell label="Ended">
            <span className="text-gray-700 dark:text-gray-200">{fmtTs(c.ended_at)}</span>
          </DetailCell>
          {durMins && (
            <DetailCell label="Duration">
              <Tooltip content={durExact ?? ""}>
                <span className="cursor-help text-gray-700 dark:text-gray-200">{durMins}</span>
              </Tooltip>
            </DetailCell>
          )}
          {c.commit && (
            <DetailCell label="Commit">
              <span className="font-mono text-gray-700 dark:text-gray-200">{c.commit}</span>
            </DetailCell>
          )}
        </div>

        {/* Task body */}
        {c.body && (
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">Task details</div>
            <pre className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm text-gray-600 dark:bg-gray-950 dark:text-gray-300">
              {c.body}
            </pre>
          </div>
        )}

        {/* AI summary */}
        {c.summary && (
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">AI summary</div>
            <div className="rounded-lg bg-emerald-50 p-3 dark:bg-emerald-950/40">
              <pre className="whitespace-pre-wrap text-sm text-emerald-800 dark:text-emerald-300">{c.summary}</pre>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

/** Shows aggregate completion stats ("N done · Xm total") above the Done section,
 *  surfacing the info from the now-removed History tab inline where it belongs. */
function DoneHistoryAnnotation() {
  const { data } = useQuery({ queryKey: ["taskq-history"], queryFn: fetchTaskqHistory });
  if (!data || data.stats.total === 0) return null;
  const totalMins = Math.round((data.stats.totalDurationS ?? 0) / 60);
  return (
    <p className="text-xs text-gray-400">
      {data.stats.total} completed total · {totalMins}m total time
    </p>
  );
}

function DetailCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-xs text-gray-400">{label}</div>
      <div>{children}</div>
    </div>
  );
}

/** The no-stall Input Queue: epic gateways awaiting a user answer. */
function InputQueuePanel() {
  const { data } = useQuery({ queryKey: ["taskq-clarifications"], queryFn: fetchTaskqClarifications });
  const qc = useQueryClient();
  const { notify } = useToast();
  const [answers, setAnswers] = useState<Record<number, string>>({});

  const answer = useMutation({
    mutationFn: (v: { id: number; answer: string }) => answerTaskqClarification(v.id, v.answer),
    onSuccess: (r) => {
      qc.setQueryData(["taskq-clarifications"], { clarifications: r.clarifications });
      qc.setQueryData(["taskq"], r.board);
      notify("Answered — child tasks released", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "answer failed", "error"),
  });

  const items = data?.clarifications ?? [];
  if (items.length === 0) return null;
  return (
    <div className={`${CARD_CLASS} mb-3 border-l-4 border-amber-400 p-3`}>
      <h3 className="mb-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
        Input needed ({items.length})
      </h3>
      <div className="space-y-3">
        {items.map((c) => (
          <div key={c.task_id} className="text-sm">
            <p className="font-medium">
              <span className="mr-1 text-gray-400">#{c.task_id}</span>
              {c.title}
            </p>
            <p className="mb-1 text-gray-600 dark:text-gray-300">{c.question}</p>
            <div className="flex gap-2">
              <input
                className={FIELD_CLASS}
                placeholder="Your answer…"
                value={answers[c.task_id] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [c.task_id]: e.target.value }))}
              />
              <button
                type="button"
                className={BTN_PRIMARY_CLASS}
                disabled={!answers[c.task_id]?.trim() || answer.isPending}
                onClick={() => answer.mutate({ id: c.task_id, answer: answers[c.task_id] })}
              >
                Answer
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}
