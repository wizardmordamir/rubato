import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { positionAtIndex, useCrossContainerDrag } from "cursedbelt/react";
import { useMemo, useState } from "react";
import {
  BOARD_STATUS_LABELS,
  BOARD_STATUSES,
  type BoardStatus,
  type BoardTask,
  deleteBoardTask,
  fetchBoardTasks,
  saveBoardTask,
  uploadBoardImage,
} from "../api";
import { Alert, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, PageHeading, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { IconGrip } from "../icons";

/**
 * Board — a simple Jira-like kanban for work tasks. Four fixed status columns;
 * cards drag between them (and reorder within one); a card opens an editor for
 * title/description/links/images/notes. Deliberately flat: no epics/stories.
 * Column headers are clickable to focus a single status; clicking "Total" or the
 * active column again resets to all-visible.
 */

const COLUMN_CLASS = "flex min-h-40 flex-1 flex-col gap-2 rounded-xl bg-gray-100 p-3 dark:bg-gray-900";

/** Position for a card appended to the end of a column. */
const endPosition = (tasks: BoardTask[]): number =>
  tasks.length ? Math.max(...tasks.map((t) => t.position)) + 1 : 1;

export function BoardPage() {
  const qc = useQueryClient();
  const { data: tasks = [] } = useQuery({ queryKey: ["board"], queryFn: fetchBoardTasks });
  const [editing, setEditing] = useState<BoardTask | "new" | null>(null);
  const [newStatus, setNewStatus] = useState<BoardStatus>("ready");
  const [filter, setFilter] = useState<BoardStatus | null>(null);

  const byStatus = useMemo(() => {
    const map = Object.fromEntries(BOARD_STATUSES.map((s) => [s, [] as BoardTask[]])) as Record<
      BoardStatus,
      BoardTask[]
    >;
    for (const t of tasks) (map[t.status] ?? map.ready).push(t);
    for (const s of BOARD_STATUSES) map[s].sort((a, b) => a.position - b.position);
    return map;
  }, [tasks]);

  const save = useMutation({
    mutationFn: saveBoardTask,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board"] }),
  });
  const remove = useMutation({
    mutationFn: deleteBoardTask,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board"] }),
  });

  // Drag (the shared @dnd-kit hook): reorder within a column AND move cards across
  // columns to a precise slot, recomputing the fractional position for the target.
  const containers = useMemo(
    () => BOARD_STATUSES.map((s) => ({ id: s, items: byStatus[s] })),
    [byStatus],
  );
  const moveCard = (from: string, to: string, fromIndex: number, toIndex: number) => {
    const task = (byStatus[from as BoardStatus] ?? [])[fromIndex];
    if (!task) return;
    const status = to as BoardStatus;
    const column = byStatus[status].filter((t) => t.id !== task.id);
    save.mutate({ ...task, status, position: positionAtIndex(column.map((t) => t.position), toIndex) });
  };
  const { ContainerContext, Container, Item } = useCrossContainerDrag<BoardTask>({
    containers,
    getKey: (t) => t.id,
    onMove: moveCard,
    renderOverlay: (task) => (
      <div className={`${CARD_CLASS} flex items-stretch gap-1 p-2 text-sm shadow-2xl`}>
        <span className="px-1 text-gray-300">
          <IconGrip size={12} />
        </span>
        <span className="py-1 font-medium">{task.title}</span>
      </div>
    ),
  });

  const CHIP_BASE = "rounded-full px-3 py-1 text-xs font-semibold transition-all";
  const CHIP_ACTIVE = "bg-accent text-white";
  const CHIP_IDLE = "bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700";

  return (
    <div className="flex h-full flex-col gap-4">
      <PageHeading title="Board" count={tasks.length} />

      {/* Filter chips: Total clears the filter; each status chip focuses that column. */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setFilter(null)}
          className={`${CHIP_BASE} ${filter === null ? CHIP_ACTIVE : CHIP_IDLE}`}
        >
          Total · {tasks.length}
        </button>
        {BOARD_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(f => f === s ? null : s)}
            className={`${CHIP_BASE} ${filter === s ? CHIP_ACTIVE : CHIP_IDLE}`}
          >
            {BOARD_STATUS_LABELS[s]} · {byStatus[s].length}
          </button>
        ))}
      </div>

      <ContainerContext>
        <div className="flex flex-1 flex-wrap gap-4 lg:flex-nowrap">
          {BOARD_STATUSES.map((status) => {
            const isDimmed = filter !== null && filter !== status;
            const isSelected = filter === status;
            return (
              <Container key={status} containerId={status}>
                {({ setNodeRef, isOver, items }) => (
                  <section
                    ref={setNodeRef}
                    aria-label={BOARD_STATUS_LABELS[status]}
                    className={`${COLUMN_CLASS} transition ${isOver ? "ring-2 ring-accent ring-inset" : ""} ${isDimmed ? "opacity-40" : ""}`}
                  >
                    <div className="flex items-center justify-between">
                      <h2
                        className={`text-xs uppercase tracking-wide transition-colors ${
                          isSelected ? "font-bold text-accent" : "font-semibold text-gray-500"
                        }`}
                      >
                        {BOARD_STATUS_LABELS[status]}
                        <span className={`ml-1.5 font-normal ${isSelected ? "text-accent/70" : "text-gray-400"}`}>
                          {items.length}
                        </span>
                      </h2>
                      <Tooltip multiline content={`Creates a new task card in the "${BOARD_STATUS_LABELS[status]}" column — a work item with a title, description, links, images, and notes that you can drag between columns as it progresses.`}>
                        <button
                          type="button"
                          className="rounded px-1.5 text-sm text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                          aria-label={`Add to ${BOARD_STATUS_LABELS[status]}`}
                          onClick={() => {
                            setNewStatus(status);
                            setEditing("new");
                          }}
                        >
                          +
                        </button>
                      </Tooltip>
                    </div>
                    {items.map((task) => (
                      <Item key={task.id} containerId={status} itemKey={task.id}>
                        {({ setNodeRef: cardRef, setActivatorNodeRef, style, handleProps }) => (
                          <div ref={cardRef} style={style} className="relative">
                            <div className={`${CARD_CLASS} flex items-stretch gap-1 p-2 text-sm transition hover:border-accent/60`}>
                              {/* Drag grip — only this drags so columns scroll freely on mobile */}
                              <button
                                type="button"
                                ref={setActivatorNodeRef}
                                {...handleProps}
                                aria-label={`Drag ${task.title}`}
                                title="Drag to move"
                                className="flex shrink-0 items-center justify-center rounded px-1 text-gray-300 hover:text-gray-500 pointer-coarse:min-h-[44px] pointer-coarse:px-2 dark:text-gray-600 dark:hover:text-gray-400"
                              >
                                <IconGrip size={12} />
                              </button>
                              {/* Card content — tap to open editor */}
                              <button
                                type="button"
                                onClick={() => setEditing(task)}
                                className="min-w-0 flex-1 py-1 text-left"
                              >
                                <span className="font-medium">{task.title}</span>
                                {task.description && <p className="mt-1 line-clamp-2 text-xs text-gray-500">{task.description}</p>}
                                {(task.links.length > 0 || task.images.length > 0) && (
                                  <p className="mt-1 text-xs text-gray-400">
                                    {task.links.length > 0 && `${task.links.length} link(s)`}
                                    {task.links.length > 0 && task.images.length > 0 && " · "}
                                    {task.images.length > 0 && `${task.images.length} image(s)`}
                                  </p>
                                )}
                              </button>
                            </div>
                          </div>
                        )}
                      </Item>
                    ))}
                  </section>
                )}
              </Container>
            );
          })}
        </div>
      </ContainerContext>

      {editing && (
        <TaskEditor
          task={editing === "new" ? null : editing}
          initialStatus={editing === "new" ? newStatus : editing.status}
          appendPosition={(s) => endPosition(byStatus[s])}
          onSave={(input, id) => {
            save.mutate({ ...input, id });
            setEditing(null);
          }}
          onDelete={(id) => {
            remove.mutate(id);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function TaskEditor({
  task,
  initialStatus,
  appendPosition,
  onSave,
  onDelete,
  onClose,
}: {
  task: BoardTask | null;
  initialStatus: BoardStatus;
  appendPosition: (s: BoardStatus) => number;
  onSave: (input: Omit<BoardTask, "id" | "createdAt" | "updatedAt">, id?: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [links, setLinks] = useState((task?.links ?? []).join("\n"));
  const [images, setImages] = useState<string[]>(task?.images ?? []);
  const [status, setStatus] = useState<BoardStatus>(task?.status ?? initialStatus);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const confirm = useConfirm();

  const upload = async (file: File) => {
    setUploading(true);
    setError("");
    try {
      const url = await uploadBoardImage(file);
      setImages((curr) => [...curr, url]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setUploading(false);
    }
  };

  const submit = () => {
    if (!title.trim()) {
      setError("Title required");
      return;
    }
    onSave(
      {
        title: title.trim(),
        description: description || undefined,
        notes: notes || undefined,
        links: links
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
        images,
        status,
        // Keep the card's slot when editing in place; append when the column changed.
        position: task && task.status === status ? task.position : appendPosition(status),
      },
      task?.id,
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="presentation"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation container, not interactive */}
      <div
        className={`${CARD_CLASS} flex max-h-full w-full max-w-xl flex-col gap-3 overflow-auto p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{task ? "Edit task" : "New task"}</h2>
          <button type="button" className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" onClick={onClose}>
            ✕
          </button>
        </div>
        <input className={FIELD_CLASS} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="title" />
        <textarea
          className={FIELD_CLASS}
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="description"
        />
        <textarea
          className={FIELD_CLASS}
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="notes"
        />
        <textarea
          className={FIELD_CLASS}
          rows={2}
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          placeholder="links (one per line)"
        />
        {links
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => (
            <a key={l} href={l} target="_blank" rel="noreferrer" className="truncate text-xs text-accent hover:underline">
              {l}
            </a>
          ))}
        <div className="flex flex-wrap items-center gap-2">
          {images.map((url) => (
            <span key={url} className="relative">
              <a href={url} target="_blank" rel="noreferrer">
                <img src={url} alt="attachment" className="h-16 w-16 rounded object-cover" />
              </a>
              <Tooltip content="Remove image">
                <button
                  type="button"
                  className="absolute -right-1 -top-1 rounded-full bg-gray-800 px-1 text-xs text-white"
                  aria-label="Remove image"
                  onClick={() => setImages((curr) => curr.filter((u) => u !== url))}
                >
                  ✕
                </button>
              </Tooltip>
            </span>
          ))}
          <label className={`${BTN_GHOST_CLASS} cursor-pointer`}>
            {uploading ? "Uploading…" : "+ Image"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <select className={FIELD_CLASS} value={status} onChange={(e) => setStatus(e.target.value as BoardStatus)}>
          {BOARD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {BOARD_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        {error && (
          <Alert tone="error">
            {error}
          </Alert>
        )}
        <div className="flex items-center gap-2">
          <button type="button" className={BTN_PRIMARY_CLASS} onClick={submit}>
            {task ? "Save" : "Create"}
          </button>
          {task && (
            <button
              type="button"
              className={`${BTN_GHOST_CLASS} text-rose-600`}
              onClick={async () => {
                if (await confirm({ prompt: "Delete this task?", confirmText: "Delete" })) onDelete(task.id);
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
