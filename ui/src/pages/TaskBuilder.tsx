import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ModalShell } from "cwip/react";
import { useMemo, useState } from "react";
import {
  createOrchestrationTask,
  FLEET_MODEL_OPTIONS,
  serializeTaskBlock,
  TASK_DRAFT_STATUS_LABELS,
  TASK_DRAFT_STATUSES,
  THINKING_LEVELS,
  updateOrchestrationTask,
  validateTaskDraft,
  type TaskDraft,
  type TaskDraftStatus,
  type TaskInsertPosition,
  type ThinkingLevel,
  type WorkflowBoard,
  type WorkflowTask,
} from "../api";
import { Alert, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, FIELD_CLASS, Spinner } from "../components";
import { useToast } from "../toast";

/**
 * The Task Builder — compose or edit a `TASKS.md` entry through a form so the
 * `(markers)` syntax (model / thinking / id / needs / group / recur) from
 * TASKS.GUIDE.md is always well-formed, and place it at the top, bottom, or
 * between two existing tasks. Saving goes through the race-safe server endpoint
 * (lock + atomic write) so it never clobbers a live worker claim.
 */

const POSITIONS: { value: TaskInsertPosition["at"]; label: string }[] = [
  { value: "top", label: "Top (highest priority)" },
  { value: "bottom", label: "Bottom" },
  { value: "before", label: "Before a task…" },
  { value: "after", label: "After a task…" },
];

/** A fresh, empty draft for the create form. */
export function blankDraft(): TaskDraft {
  return { status: "ready", title: "" };
}

/** A short, de-duplicated label for an anchor-task dropdown option. */
function anchorLabel(t: WorkflowTask): string {
  const title = t.title.length > 70 ? `${t.title.slice(0, 70)}…` : t.title;
  return `[${t.status}] ${title}`;
}

export function TaskBuilderModal({
  mode,
  board,
  initial,
  anchorHeading,
  onClose,
}: {
  mode: "create" | "edit";
  board: WorkflowBoard;
  /** Seed draft — blank for create, {@link draftFromTask} for edit. */
  initial: TaskDraft;
  /** The verbatim heading of the task being edited (edit mode only). */
  anchorHeading?: string;
  onClose: () => void;
}) {
  const { notify } = useToast();
  const qc = useQueryClient();

  const [status, setStatus] = useState<TaskDraftStatus>(initial.status);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body ?? "");
  const [model, setModel] = useState(initial.model ?? "");
  const [think, setThink] = useState<string>(initial.thinkingLevel ?? "");
  const [id, setId] = useState(initial.id ?? "");
  const [needsRaw, setNeedsRaw] = useState((initial.needs ?? []).join(", "));
  const [group, setGroup] = useState(initial.group ?? "");
  const [recurring, setRecurring] = useState(initial.recur != null);
  const [recurN, setRecurN] = useState(initial.recur != null ? String(initial.recur) : "10");

  // Create-only: where the new task lands.
  const [posAt, setPosAt] = useState<TaskInsertPosition["at"]>("top");
  const [posAnchor, setPosAnchor] = useState<string>(board.tasks[0]?.rawHeading ?? "");

  const needsList = useMemo(
    () =>
      needsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    [needsRaw],
  );

  const draft: TaskDraft = useMemo(
    () => ({
      status,
      title,
      body: body.trim() ? body : undefined,
      model: model || undefined,
      thinkingLevel: think ? (think as ThinkingLevel) : undefined,
      id: id.trim() || undefined,
      needs: needsList.length ? needsList : undefined,
      group: group.trim() || undefined,
      recur: recurring ? Number.parseInt(recurN, 10) || undefined : undefined,
      // Preserve a recurring task's drainer-maintained run stamp across edits.
      recurLast: recurring ? initial.recurLast : undefined,
    }),
    [status, title, body, model, think, id, needsList, group, recurring, recurN, initial.recurLast],
  );

  const errors = useMemo(() => validateTaskDraft(draft), [draft]);
  const needsAnchor = mode === "create" && (posAt === "before" || posAt === "after");
  const positionError = needsAnchor && !posAnchor ? "pick the task to position relative to" : null;

  const preview = useMemo(() => {
    try {
      return serializeTaskBlock(draft);
    } catch {
      return null;
    }
  }, [draft]);

  const save = useMutation({
    mutationFn: async () => {
      if (mode === "create") {
        const position: TaskInsertPosition = needsAnchor ? { at: posAt, anchorHeading: posAnchor } : { at: posAt };
        return createOrchestrationTask(draft, position);
      }
      if (!anchorHeading) throw new Error("missing task anchor");
      return updateOrchestrationTask(anchorHeading, draft);
    },
    onSuccess: (res) => {
      // Seed the overview query's board so the list updates instantly.
      qc.setQueryData(["orchestration"], (prev: unknown) =>
        prev && typeof prev === "object" ? { ...(prev as object), board: res.board } : prev,
      );
      qc.invalidateQueries({ queryKey: ["orchestration"] });
      notify(mode === "create" ? "Task added to TASKS.md" : "Task updated", "success");
      onClose();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const canSave = errors.length === 0 && !positionError && !save.isPending;

  return (
    <ModalShell
      size="lg"
      title={mode === "create" ? "New task" : "Edit task"}
      subtitle="Composes a well-formed TASKS.md entry (see TASKS.GUIDE.md)."
      onClose={onClose}
      confirmOnClose
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={onClose} disabled={save.isPending}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => save.mutate()} disabled={!canSave}>
            {save.isPending && <Spinner />}
            {mode === "create" ? "Add task" : "Save changes"}
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Status" hint="ready = claimable; hold = your manual pause; not-ready = external dep">
          <select className={FIELD_CLASS} value={status} onChange={(e) => setStatus(e.target.value as TaskDraftStatus)}>
            {TASK_DRAFT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TASK_DRAFT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>

        {mode === "create" && (
          <Field label="Position" hint="Top = highest priority; or place relative to another task">
            <div className="flex gap-2">
              <select
                className={FIELD_CLASS}
                value={posAt}
                onChange={(e) => setPosAt(e.target.value as TaskInsertPosition["at"])}
              >
                {POSITIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              {needsAnchor && (
                <select className={FIELD_CLASS} value={posAnchor} onChange={(e) => setPosAnchor(e.target.value)}>
                  <option value="">— pick a task —</option>
                  {board.tasks.map((t) => (
                    <option key={t.rawHeading} value={t.rawHeading}>
                      {anchorLabel(t)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Field>
        )}

        <div className="md:col-span-2">
          <Field label="Title" hint="One line — the task heading">
            <input
              className={FIELD_CLASS}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. ru: add a password-strength meter to vault settings"
            />
          </Field>
        </div>

        <div className="md:col-span-2">
          <Field label="Details" hint="Optional body lines beneath the heading">
            <textarea
              className={`${FIELD_CLASS} min-h-[5rem] font-mono`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Optional detail / acceptance notes…"
            />
          </Field>
        </div>

        <Field label="Model" hint="(model:…) override — blank uses the drainer default">
          <select className={FIELD_CLASS} value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Default</option>
            {FLEET_MODEL_OPTIONS.map((m) => (
              <option key={m.alias} value={m.alias}>
                {m.label} ({m.alias})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Thinking" hint="(think:…) budget — blank uses the drainer default">
          <select className={FIELD_CLASS} value={think} onChange={(e) => setThink(e.target.value)}>
            <option value="">Default</option>
            {THINKING_LEVELS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Id" hint="(id:X) — referenceable id so a follow-up can depend on it">
          <input
            className={FIELD_CLASS}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. vault-ui"
          />
        </Field>

        <Field label="Needs" hint="(needs:X,Y) — comma-separated ids this task is blocked on">
          <input
            className={FIELD_CLASS}
            value={needsRaw}
            onChange={(e) => setNeedsRaw(e.target.value)}
            placeholder="e.g. vault-ui, db-migrate"
          />
        </Field>

        <Field label="Group" hint="(group:G) — done together by one worker">
          <input
            className={FIELD_CLASS}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="e.g. vault"
          />
        </Field>

        <Field label="Recurring" hint="(recur:N) — runs after one-shots, then waits N completions">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)}
              className="h-4 w-4"
            />
            <span className="text-sm text-gray-500">every</span>
            <input
              type="number"
              min={1}
              className={`${FIELD_CLASS} w-24`}
              value={recurN}
              onChange={(e) => setRecurN(e.target.value)}
              disabled={!recurring}
            />
            <span className="text-sm text-gray-500">tasks</span>
          </div>
        </Field>
      </div>

      {(errors.length > 0 || positionError) && (
        <Alert tone="error" className="mt-4">
          <ul className="list-inside list-disc text-sm">
            {errors.map((er) => (
              <li key={er}>{er}</li>
            ))}
            {positionError && <li>{positionError}</li>}
          </ul>
        </Alert>
      )}

      <div className="mt-4">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Preview (what gets written)</p>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-xs text-gray-700 dark:bg-gray-950 dark:text-gray-300">
          {preview ?? "— fix the errors above to see the entry —"}
        </pre>
      </div>
    </ModalShell>
  );
}

/** A labelled form field with an optional hint line. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}
