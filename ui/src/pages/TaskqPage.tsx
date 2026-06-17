import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DragHandle, DropIndicator, ModalShell, useDragReorder } from "cwip/react";
import { useState } from "react";
import {
  answerTaskqClarification,
  calibrateTaskqBucket,
  createTaskqTask,
  deleteTaskqTask,
  fetchTaskqBoard,
  fetchTaskqClarifications,
  fetchTaskqDrainer,
  fetchTaskqHistory,
  fetchTaskqUsage,
  moveTaskqTask,
  resumeTaskqDrainer,
  runTaskqDrainer,
  setTaskqStatus,
  stopTaskqDrainer,
  type TaskqBucketState,
  TASKQ_AUTHORABLE_STATUSES,
  TASKQ_MODEL_ALIASES,
  TASKQ_STATUS_LABELS,
  TASKQ_STATUSES,
  TASKQ_THINK_LEVELS,
  type TaskqBoard,
  fetchTaskqConfig,
  fetchTaskqInstances,
  fetchTaskqLogs,
  releaseTaskqInstance,
  saveTaskqConfig,
  setTaskqInterval,
  setTaskqWatchdog,
  type TaskqConfig,
  type TaskqConfigPatch,
  type TaskqFleetTier,
  type TaskqInstance,
  type TaskqNewTask,
  type TaskqPosition,
  type TaskqStatus,
  type TaskqTaskView,
  updateTaskqTask,
} from "../api";
import { Alert, Badge, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, PageHeading, Spinner, Tabs } from "../components";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";

type TaskqTab = "board" | "workers" | "settings" | "history" | "usage";
const TASKQ_TABS: readonly { key: TaskqTab; label: string }[] = [
  { key: "board", label: "Board" },
  { key: "workers", label: "Workers" },
  { key: "settings", label: "Settings" },
  { key: "history", label: "History" },
  { key: "usage", label: "Usage" },
];

/**
 * Taskq — the v2 orchestrator board + builder, backed by the SQLite queue
 * (cwip/taskq via /api/taskq). Runs alongside the legacy Orchestration page
 * until cutover. Edits are by stable row id (no fragile heading-anchor), so
 * there's no clobber/conflict surface — the DB is the single writer authority.
 */

/** Statuses where drag-reorder changes claim priority (running/done are not). */
const REORDERABLE = new Set<TaskqStatus>(["ready", "on_hold", "not_ready", "blocked", "pending_triage"]);

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
    refetchInterval: (q) => (q.state.data?.counts.claimed ? 4000 : false),
  });
  const [builder, setBuilder] = useState<{ mode: "create" } | { mode: "edit"; task: TaskqTaskView } | null>(null);
  const [tab, setTab] = useState<TaskqTab>("board");
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

  return (
    <div className="flex h-full flex-col">
      <PageHeading
        title="Orchestration"
        actions={
          tab === "board" ? (
            <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => setBuilder({ mode: "create" })}>
              + New task
            </button>
          ) : undefined
        }
      />
      <Tabs<TaskqTab> tabs={TASKQ_TABS} active={tab} onChange={setTab} />

      <div className="min-h-0 flex-1 overflow-auto pt-3">
        {tab === "board" && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {TASKQ_STATUSES.filter((s) => board.counts[s] > 0).map((s) => (
                <Badge key={s} tone={STATUS_TONE[s]}>
                  {TASKQ_STATUS_LABELS[s]}: {board.counts[s]}
                </Badge>
              ))}
              <Badge tone="neutral">Total: {board.total}</Badge>
            </div>
            <InputQueuePanel />
            {board.total === 0 ? (
              <p className="text-gray-400">No tasks yet — add one with “New task”.</p>
            ) : (
              TASKQ_STATUSES.filter((s) => board.tasks.some((t) => t.status === s)).map((s) => (
                <BoardSection
                  key={s}
                  status={s}
                  tasks={board.tasks.filter((t) => t.status === s)}
                  count={board.counts[s]}
                  reorderable={REORDERABLE.has(s)}
                  onReorder={(ids) => onReorder(board, s, ids)}
                  onEdit={(t) => setBuilder({ mode: "edit", task: t })}
                  onDelete={async (t) => {
                    if (await confirm({ prompt: `Delete "${t.title}"?`, confirmText: "Delete" })) del.mutate(t.id);
                  }}
                  onHold={(t) =>
                    status.mutate(t.status === "on_hold" ? { id: t.id, status: "ready" } : { id: t.id, status: "on_hold" })
                  }
                />
              ))
            )}
          </div>
        )}
        {tab === "workers" && (
          <div className="space-y-4">
            <DrainerControl />
            <InstancesPanel />
            <LogsPanel />
          </div>
        )}
        {tab === "settings" && <SettingsPanel />}
        {tab === "history" && <HistoryPanel />}
        {tab === "usage" && <UsagePanel />}
      </div>

      {builder && (
        <TaskqBuilderModal
          mode={builder.mode}
          board={board}
          task={builder.mode === "edit" ? builder.task : undefined}
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

function TaskCard({
  task,
  onEdit,
  onDelete,
  onHold,
  dragHandle,
}: {
  task: TaskqTaskView;
  onEdit: () => void;
  onDelete: () => void;
  onHold: () => void;
  /** A drag-grip element (from the section's useDragReorder), when reorderable. */
  dragHandle?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const editable = task.status !== "claimed" && task.status !== "done";
  const markers = [
    task.model && `model:${task.model}`,
    task.think && `think:${task.think}`,
    task.slug && `id:${task.slug}`,
    task.needs.length > 0 && `needs:${task.needs.join(",")}`,
    task.group_key && `group:${task.group_key}`,
    task.recur_n != null && `recur:${task.recur_n}`,
    task.repo && `repo:${task.repo}`,
  ].filter(Boolean) as string[];
  return (
    <div className={`group ${CARD_CLASS} flex gap-2 p-3`}>
      {dragHandle}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">
              <span className="mr-1 text-gray-400">#{task.id}</span>
              {task.title}
            </p>
            {markers.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1 font-mono text-xs text-gray-500">
                {markers.map((m) => (
                  <span key={m} className="rounded bg-gray-100 px-1 dark:bg-gray-800">
                    {m}
                  </span>
                ))}
              </div>
            )}
            {task.note && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">note: {task.note}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {editable && (
              <>
                <button type="button" onClick={onEdit} className="text-xs text-accent hover:underline">
                  Edit
                </button>
                <button type="button" onClick={onHold} className="text-xs text-amber-600 hover:underline dark:text-amber-400">
                  {task.status === "on_hold" ? "Unhold" : "Hold"}
                </button>
                <button type="button" onClick={onDelete} className="text-xs text-red-600 hover:underline dark:text-red-400">
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
        {task.body && (
          <button type="button" onClick={() => setOpen((o) => !o)} className="mt-2 text-xs text-accent hover:underline">
            {open ? "Hide details" : "Show details"}
          </button>
        )}
        {open && task.body && (
          <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-950 dark:text-gray-300">
            {task.body}
          </pre>
        )}
      </div>
    </div>
  );
}

/** A status section that supports drag-to-reorder (priority) via cwip's useDragReorder. */
function BoardSection({
  status,
  tasks,
  count,
  reorderable,
  onReorder,
  onEdit,
  onDelete,
  onHold,
}: {
  status: TaskqStatus;
  tasks: TaskqTaskView[];
  count: number;
  reorderable: boolean;
  onReorder: (ids: number[]) => void;
  onEdit: (t: TaskqTaskView) => void;
  onDelete: (t: TaskqTaskView) => void;
  onHold: (t: TaskqTaskView) => void;
}) {
  const ids = tasks.map((t) => String(t.id));
  const dr = useDragReorder({ ids, axis: "y", onReorder: (next) => onReorder(next.map(Number)) });
  const canDrag = reorderable && tasks.length > 1;
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        {TASKQ_STATUS_LABELS[status]} <span className="text-gray-400">({count})</span>
        {canDrag && <span className="ml-2 font-normal normal-case text-gray-400">— drag to reorder priority</span>}
      </h3>
      <div {...(canDrag ? dr.containerProps : {})} className="space-y-2">
        {tasks.map((t) => {
          if (!canDrag) {
            return <TaskCard key={t.id} task={t} onEdit={() => onEdit(t)} onDelete={() => onDelete(t)} onHold={() => onHold(t)} />;
          }
          const idStr = String(t.id);
          const ip = dr.getItemProps(idStr);
          return (
            <div
              key={t.id}
              data-drag-id={ip["data-drag-id"]}
              style={ip.style}
              onClickCapture={ip.onClickCapture}
              className={`relative ${ip.isDragging ? "opacity-70" : ""}`}
            >
              {ip.insertBefore && <DropIndicator orientation="horizontal" side="start" />}
              {ip.insertAfter && <DropIndicator orientation="horizontal" side="end" />}
              <TaskCard
                task={t}
                onEdit={() => onEdit(t)}
                onDelete={() => onDelete(t)}
                onHold={() => onHold(t)}
                dragHandle={<DragHandle handleProps={dr.getHandleProps(idStr)} label={`Reorder ${t.title}`} />}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Multi-select for task dependencies (`needs:`) — pick by id + title from a
 *  searchable dropdown (with a body preview on hover), or type a custom id. */
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
  const options = board.tasks.filter((t) => t.slug && t.id !== excludeId);
  const f = filter.trim().toLowerCase();
  const filtered = f ? options.filter((o) => `${o.slug} ${o.title}`.toLowerCase().includes(f)) : options;
  const toggle = (slug: string) => onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug]);
  const addCustom = () => {
    if (custom.trim()) {
      toggle(custom.trim());
      setCustom("");
    }
  };
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
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
      {open && (
        <>
          <button type="button" aria-label="close dropdown" className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900">
            {/* biome-ignore lint/a11y/noAutofocus: focusing the filter on open is the intended UX */}
            <input autoFocus className={FIELD_CLASS} placeholder="filter by id or title…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="mt-2 space-y-0.5">
              {filtered.map((o) => (
                <label
                  key={o.id}
                  title={o.body || undefined}
                  className="flex cursor-pointer items-start gap-2 rounded p-1 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <input
                    type="checkbox"
                    checked={value.includes(o.slug as string)}
                    onChange={() => toggle(o.slug as string)}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="font-mono text-xs text-accent">{o.slug}</span> <span className="text-sm">{o.title}</span>
                    {o.body && <span className="block truncate text-xs text-gray-400">{o.body}</span>}
                  </span>
                </label>
              ))}
              {filtered.length === 0 && (
                <p className="px-1 py-2 text-xs text-gray-400">
                  No tasks with an id match. Give a task an Id to depend on it, or add a custom id below.
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
        </>
      )}
    </div>
  );
}

function TaskqBuilderModal({
  mode,
  board,
  task,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  board: TaskqBoard;
  task?: TaskqTaskView;
  onClose: () => void;
  onSaved: (board: TaskqBoard) => void;
}) {
  const { notify } = useToast();
  const [statusV, setStatusV] = useState<TaskqStatus>(task?.status ?? "ready");
  const [title, setTitle] = useState(task?.title ?? "");
  const [body, setBody] = useState(task?.body ?? "");
  const [model, setModel] = useState(task?.model ?? "");
  const [think, setThink] = useState(task?.think ?? "");
  const [slug, setSlug] = useState(task?.slug ?? "");
  const [repo, setRepo] = useState(task?.repo ?? "");
  const [needs, setNeeds] = useState<string[]>(task?.needs ?? []);
  const [group, setGroup] = useState(task?.group_key ?? "");
  const [recurring, setRecurring] = useState(task?.recur_n != null);
  const [recurN, setRecurN] = useState(task?.recur_n != null ? String(task.recur_n) : "10");
  const [note, setNote] = useState(task?.note ?? "");
  const [posAt, setPosAt] = useState<TaskqPosition["at"]>("top");
  const [posAnchor, setPosAnchor] = useState<number | "">(board.tasks[0]?.id ?? "");

  const draft: TaskqNewTask = {
    title,
    status: statusV,
    body: body.trim() || undefined,
    model: model || undefined,
    think: think || undefined,
    slug: slug.trim() || undefined,
    repo: repo.trim() || undefined,
    needs,
    group_key: group.trim() || undefined,
    recur_n: recurring ? Number.parseInt(recurN, 10) || undefined : undefined,
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
      return (
        await updateTaskqTask(task.id, {
          title,
          status: statusV,
          body,
          model,
          think,
          slug,
          repo,
          needs,
          group_key: group,
          note,
          ...(recurring ? { recur_n: Number.parseInt(recurN, 10) || undefined } : {}),
        })
      ).board;
    },
    onSuccess: (board) => {
      notify(mode === "create" ? "Task added" : "Task updated", "success");
      onSaved(board);
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const titleError = !title.trim();

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
          <Field label="Title">
            <input className={FIELD_CLASS} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What to do" />
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

        <Field label="Recurring">
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} className="h-4 w-4" />
            <span className="text-sm text-gray-500">every</span>
            <input type="number" min={1} className={`${FIELD_CLASS} w-20`} value={recurN} onChange={(e) => setRecurN(e.target.value)} disabled={!recurring} />
            <span className="text-sm text-gray-500">done</span>
          </div>
        </Field>
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

/** Token-usage capacities + a manual /usage calibration form (the dependable telemetry). */
function UsagePanel() {
  const { data } = useQuery({ queryKey: ["taskq-usage"], queryFn: fetchTaskqUsage });
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

  const buckets = data?.buckets ?? [];
  return (
    <div className={`${CARD_CLASS} mb-3 p-3`}>
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-4">
          {buckets.map((b: TaskqBucketState) => {
            const pctRemain = Math.round(b.fraction * 100);
            const tone = b.fraction < 0.12 ? "text-red-600" : b.fraction < 0.4 ? "text-amber-600" : "text-emerald-600";
            return (
              <div key={b.key} className="text-xs">
                <div className="text-gray-500">{BUCKET_LABELS[b.key] ?? b.key}</div>
                <div className={`font-semibold ${tone}`}>
                  {pctRemain}% left
                  {b.resetInSeconds != null && (
                    <span className="ml-1 font-normal text-gray-400">· resets {Math.round(b.resetInSeconds / 3600)}h</span>
                  )}
                </div>
              </div>
            );
          })}
          {buckets.length === 0 && <span className="text-xs text-gray-400">No usage data — calibrate from /usage.</span>}
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs text-accent hover:underline">
          {open ? "Close" : "Calibrate"}
        </button>
      </div>
      {open && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
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
      )}
    </div>
  );
}

/** Drainer status + control (replaces the old Watchdog tab). */
function DrainerControl() {
  const { data } = useQuery({ queryKey: ["taskq-drainer"], queryFn: fetchTaskqDrainer, refetchInterval: 5000 });
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
      notify("Graceful stop set — workers exit between tasks", "success");
    },
  });
  const resume = useMutation({
    mutationFn: resumeTaskqDrainer,
    onSuccess: (r) => {
      qc.setQueryData(["taskq-drainer"], r.status);
      notify("Resumed", "success");
    },
  });

  const s = data;
  const dot = (on: boolean, label: string, tone: string) => (
    <span className={`flex items-center gap-1 text-xs ${tone}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${on ? "bg-current" : "bg-gray-300 dark:bg-gray-600"}`} />
      {label}
    </span>
  );
  return (
    <div className={`${CARD_CLASS} mb-3 flex flex-wrap items-center justify-between gap-3 p-3`}>
      <div className="flex flex-wrap items-center gap-4">
        {dot(!!s?.watchdogLoaded, s?.watchdogLoaded ? "Watchdog loaded" : "Watchdog off", s?.watchdogLoaded ? "text-emerald-600" : "text-gray-400")}
        {dot(!!s?.running, s?.running ? "Draining now" : "Idle", s?.running ? "text-accent" : "text-gray-400")}
        {s?.stopped && dot(true, "Stop sentinel set", "text-amber-600")}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={BTN_GHOST_CLASS} onClick={() => run.mutate()} disabled={run.isPending || s?.running}>
          Run now
        </button>
        {s?.stopped ? (
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => resume.mutate()} disabled={resume.isPending}>
            Resume
          </button>
        ) : (
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => stop.mutate()} disabled={stop.isPending}>
            Graceful stop
          </button>
        )}
      </div>
    </div>
  );
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Live worker instances (current leases) + per-instance release. */
function InstancesPanel() {
  const { data } = useQuery({ queryKey: ["taskq-instances"], queryFn: fetchTaskqInstances, refetchInterval: 4000 });
  const qc = useQueryClient();
  const { notify } = useToast();
  const release = useMutation({
    mutationFn: (id: number) => releaseTaskqInstance(id),
    onSuccess: (r) => {
      qc.setQueryData(["taskq-instances"], { instances: r.instances });
      qc.setQueryData(["taskq"], r.board);
      notify("Released → ready", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "release failed", "error"),
  });
  const items = data?.instances ?? [];
  const now = Date.now();
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Live instances <span className="text-gray-400">({items.length})</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400">No workers claimed right now.</p>
      ) : (
        <div className="space-y-1">
          {items.map((i) => (
            <div key={i.task_id} className={`${CARD_CLASS} flex items-center justify-between gap-3 p-2 text-xs`}>
              <div className="min-w-0">
                <p className="truncate font-medium">
                  <span className="text-gray-400">#{i.task_id}</span> {i.title}
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-gray-500">
                  <span>worker {i.worker_id}</span>
                  {i.model && <Badge tone="neutral">{i.model}</Badge>}
                  {i.repo && <span>{i.repo}</span>}
                  <span>running {fmtDur(now - i.claimed_at)}</span>
                  <span>hb {fmtDur(now - i.heartbeat_at)} ago</span>
                  {now > i.expires_at && <span className="text-amber-600 dark:text-amber-400">lease expired</span>}
                </div>
              </div>
              <button type="button" className={BTN_GHOST_CLASS} disabled={release.isPending} onClick={() => release.mutate(i.task_id)}>
                Release
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-gray-400">
        Release returns a task to “ready” (drops the lease). To stop ALL work, use Graceful stop above. To cap how
        many run at once, set Jobs / fleet tiers in Settings.
      </p>
    </section>
  );
}

/** Tail of the watchdog log. */
function LogsPanel() {
  const { data } = useQuery({ queryKey: ["taskq-logs"], queryFn: () => fetchTaskqLogs(200), refetchInterval: 5000 });
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Watchdog log</h3>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-950 p-3 text-xs text-gray-300">
        {(data?.lines ?? []).join("\n") || "(empty)"}
      </pre>
      {data?.path && <p className="mt-1 font-mono text-xs text-gray-400">{data.path}</p>}
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
  const [ttlMin, setTtlMin] = useState(Math.round(config.leaseTtlMs / 60000));
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
        leaseTtlMs: ttlMin * 60000,
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
          <Field label={`Max instances (jobs): ${jobs}`} hint="Concurrent workers when no fleet tiers are set.">
            <input type="range" min={1} max={16} value={jobs} onChange={(e) => setJobs(Number(e.target.value))} className="w-full" />
          </Field>
          <Field label="Default model" hint="Used when a task pins no model.">
            <select className={FIELD_CLASS} value={model} onChange={(e) => setModel(e.target.value)}>
              {TASKQ_MODEL_ALIASES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Default thinking" hint="Fallback when a task pins none.">
            <select className={FIELD_CLASS} value={think} onChange={(e) => setThink(e.target.value)}>
              <option value="">off / unset</option>
              {TASKQ_THINK_LEVELS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Lease TTL (min)" hint="Reaped + retried if a worker doesn't heartbeat within this.">
            <input type="number" min={1} className={FIELD_CLASS} value={ttlMin} onChange={(e) => setTtlMin(Number(e.target.value))} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} className="h-4 w-4" />
            Fast mode default
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={triage} onChange={(e) => setTriage(e.target.checked)} className="h-4 w-4" />
            Auto-triage (grade blank tasks + decompose epics)
          </label>
        </div>
      </section>

      {/* Fleet tiers */}
      <section className={`${CARD_CLASS} p-4`}>
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-gray-500">Fleet tiers</h3>
        <p className="mb-3 text-xs text-gray-400">Per-model worker pools — overrides the flat Jobs above. Each tier only claims tasks for its models (untagged tasks match any).</p>
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
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Watchdog (launchd)</h3>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={watchdogLoaded ? "success" : "neutral"}>{watchdogLoaded ? "loaded" : "not loaded"}</Badge>
          {watchdogLoaded ? (
            <button type="button" className={BTN_GHOST_CLASS} onClick={() => watchdog.mutate("unload")} disabled={watchdog.isPending}>
              Unload
            </button>
          ) : (
            <button type="button" className={BTN_GHOST_CLASS} onClick={() => watchdog.mutate("load")} disabled={watchdog.isPending}>
              Load
            </button>
          )}
          <span className="text-sm text-gray-500">Tick every</span>
          <input type="number" min={30} className={`${FIELD_CLASS} w-24`} value={intervalS} onChange={(e) => setIntervalS(Number(e.target.value))} />
          <span className="text-sm text-gray-500">s</span>
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => setIntv.mutate()} disabled={setIntv.isPending}>
            Set interval
          </button>
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
  const recent = data?.recent ?? [];
  if (recent.length === 0) return null;
  const mins = Math.round((data?.stats.totalDurationS ?? 0) / 60);
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        History <span className="text-gray-400">({data?.stats.total} done · {mins}m total)</span>
      </h3>
      <div className="space-y-1">
        {recent.map((c) => (
          <div key={`${c.task_id}-${c.ended_at}`} className={`${CARD_CLASS} flex items-center justify-between gap-3 p-2 text-xs`}>
            <span className="min-w-0 truncate">
              <span className="text-gray-400">#{c.task_id}</span> {c.title}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-gray-500">
              {c.repo && <Badge tone="neutral">{c.repo}</Badge>}
              {c.commit && <span className="font-mono">{c.commit.slice(0, 7)}</span>}
              {c.duration_s != null && <span>{Math.round(c.duration_s / 60)}m</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
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
