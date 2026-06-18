import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  createDraft,
  createForgePrompt,
  type DraftDetail,
  deleteDraft,
  deleteForgePrompt,
  enhanceDraft,
  fetchDraftDetail,
  fetchDrafts,
  fetchForgePrompts,
  type ForgePrompt,
  FORGE_TARGET_STATUSES,
  type ForgeTargetStatus,
  publishDraft,
  type ForgeDraft,
  updateDraft,
  updateForgePrompt,
  updateRevision,
} from "../api";
import {
  Alert,
  Badge,
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  Dropdown,
  FIELD_CLASS,
  PageHeading,
} from "../components";
import { useConfirm } from "../confirm";
import { IconPlus, IconTrash, IconZap } from "../icons";
import { Modal } from "../Modal";
import { useToast } from "../toast";

/**
 * Task Forge — write a rough task draft, let the local Ollama rewrite it into a
 * queue-ready spec (iterate as many times as you like with a default / saved /
 * typed / edited prompt), review it side-by-side against the original, then
 * publish the good ones into the taskq orchestrator queue.
 */

const STATUS_LABELS: Record<ForgeTargetStatus, string> = {
  draft: "Draft (keep iterating)",
  hold: "Hold (review then publish)",
  ready: "Ready (auto-publish to queue)",
};

const STATE_TONE: Record<ForgeDraft["enhance_state"], "neutral" | "accent" | "warn" | "error"> = {
  idle: "neutral",
  queued: "accent",
  processing: "warn",
  error: "error",
};

export function ForgePage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const onError = (e: unknown) => notify(e instanceof Error ? e.message : "request failed", "error");

  const { data: drafts = [] } = useQuery({ queryKey: ["forge-drafts"], queryFn: fetchDrafts });
  const { data: prompts = [] } = useQuery({ queryKey: ["forge-prompts"], queryFn: fetchForgePrompts });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [managingPrompts, setManagingPrompts] = useState(false);

  // Keep a valid selection as the list changes.
  useEffect(() => {
    if (selectedId == null && drafts.length) setSelectedId(drafts[0].id);
    if (selectedId != null && !drafts.some((d) => d.id === selectedId)) setSelectedId(drafts[0]?.id ?? null);
  }, [drafts, selectedId]);

  const invalidateList = () => qc.invalidateQueries({ queryKey: ["forge-drafts"] });

  const create = useMutation({
    mutationFn: createDraft,
    onSuccess: (d) => {
      invalidateList();
      setSelectedId(d.id);
      setCreating(false);
    },
    onError,
  });

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <PageHeading title="Task Forge" />
        <div className="flex gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => setManagingPrompts(true)}>
            Prompts
          </button>
          <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => setCreating(true)}>
            <IconPlus /> New Draft
          </button>
        </div>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <DraftList drafts={drafts} selectedId={selectedId} onSelect={setSelectedId} />
        {selectedId == null ? (
          <div className={`${CARD_CLASS} flex items-center justify-center text-sm text-gray-500`}>
            Select a draft, or create one to get started.
          </div>
        ) : (
          <DraftDetailPane key={selectedId} draftId={selectedId} prompts={prompts} onChanged={invalidateList} />
        )}
      </div>

      {creating && (
        <NewDraftModal
          onClose={() => setCreating(false)}
          onCreate={(input) => create.mutate(input)}
          busy={create.isPending}
        />
      )}
      {managingPrompts && <PromptManagerModal prompts={prompts} onClose={() => setManagingPrompts(false)} />}
    </div>
  );
}

function DraftList({
  drafts,
  selectedId,
  onSelect,
}: {
  drafts: ForgeDraft[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <div className={`${CARD_CLASS} flex flex-col gap-1 overflow-auto p-2`}>
      {drafts.length === 0 && <p className="p-3 text-sm text-gray-500">No drafts yet.</p>}
      {drafts.map((d) => (
        <button
          type="button"
          key={d.id}
          onClick={() => onSelect(d.id)}
          className={`flex flex-col gap-1 rounded-md px-3 py-2 text-left text-sm transition ${
            d.id === selectedId ? "bg-accent-soft text-accent" : "hover:bg-gray-100 dark:hover:bg-gray-800"
          }`}
        >
          <span className="truncate font-medium">{d.title}</span>
          <span className="flex items-center gap-2">
            <Badge tone={STATE_TONE[d.enhance_state]}>{d.enhance_state}</Badge>
            <Badge tone="neutral">{d.target_status}</Badge>
            {d.published_task_id != null && <Badge tone="success">published</Badge>}
          </span>
        </button>
      ))}
    </div>
  );
}

function DraftDetailPane({
  draftId,
  prompts,
  onChanged,
}: {
  draftId: number;
  prompts: ForgePrompt[];
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const onError = (e: unknown) => notify(e instanceof Error ? e.message : "request failed", "error");

  const { data: detail } = useQuery({
    queryKey: ["forge-draft", draftId],
    queryFn: () => fetchDraftDetail(draftId),
    // Poll while a round is in flight so the new revision shows up when Ollama finishes.
    refetchInterval: (q) => {
      const s = (q.state.data as DraftDetail | undefined)?.draft.enhance_state;
      return s === "queued" || s === "processing" ? 1500 : false;
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["forge-draft", draftId] });
    onChanged();
  };

  const enhance = useMutation({
    mutationFn: (req: { promptId?: number; promptText?: string }) => enhanceDraft(draftId, req),
    onSuccess: refresh,
    onError,
  });
  const setStatus = useMutation({
    mutationFn: (target_status: ForgeTargetStatus) => updateDraft(draftId, { target_status }),
    onSuccess: refresh,
    onError,
  });
  const publish = useMutation({
    mutationFn: () => publishDraft(draftId),
    onSuccess: (d) => {
      refresh();
      notify(`Published to taskq #${d.published_task_id}`, "success");
    },
    onError,
  });
  const remove = useMutation({ mutationFn: () => deleteDraft(draftId), onSuccess: onChanged, onError });

  if (!detail) return <div className={CARD_CLASS}>Loading…</div>;
  const { draft, revisions } = detail;
  const current = revisions.find((r) => r.id === draft.current_enhanced_id) ?? revisions[0] ?? null;

  return (
    <div className="flex flex-col gap-4 overflow-auto">
      {/* Controls */}
      <div className={`${CARD_CLASS} flex flex-wrap items-center gap-3`}>
        <div className="min-w-[220px]">
          <span className="mb-1 block text-xs text-gray-500">Target status</span>
          <Dropdown
            options={FORGE_TARGET_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
            value={draft.target_status}
            onChange={(v) => setStatus.mutate(v as ForgeTargetStatus)}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {draft.published_task_id != null ? (
            <Badge tone="success">Published → taskq #{draft.published_task_id}</Badge>
          ) : (
            <button
              type="button"
              className={BTN_GHOST_CLASS}
              disabled={!current || publish.isPending}
              onClick={() => publish.mutate()}
            >
              Publish to queue
            </button>
          )}
          <button
            type="button"
            className={BTN_GHOST_CLASS}
            onClick={async () => {
              if (await confirm({ prompt: `Delete draft "${draft.title}"?`, confirmText: "Delete" })) remove.mutate();
            }}
          >
            <IconTrash />
          </button>
        </div>
      </div>

      {draft.enhance_state === "error" && draft.last_error && (
        <Alert tone="error" title="Enhancement failed">
          {draft.last_error} — check that Ollama is running, then re-send.
        </Alert>
      )}

      {/* Side-by-side comparator */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className={`${CARD_CLASS} flex flex-col gap-2`}>
          <Badge tone="neutral">Your Original Concept</Badge>
          <h3 className="font-medium">{draft.title}</h3>
          <pre className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{draft.raw_content}</pre>
        </div>
        <SpecPanel
          revisions={revisions}
          current={current}
          busy={draft.enhance_state === "queued" || draft.enhance_state === "processing"}
          onSaveEdit={async (revId, spec) => {
            await updateRevision(revId, spec);
            refresh();
            notify("Saved spec edits", "success");
          }}
        />
      </div>

      {/* Enhance bar */}
      <EnhanceBar prompts={prompts} busy={enhance.isPending} onSend={(req) => enhance.mutate(req)} />
    </div>
  );
}

function SpecPanel({
  revisions,
  current,
  busy,
  onSaveEdit,
}: {
  revisions: DraftDetail["revisions"];
  current: DraftDetail["revisions"][number] | null;
  busy: boolean;
  onSaveEdit: (revId: number, spec: string) => void | Promise<void>;
}) {
  const [viewId, setViewId] = useState<number | null>(current?.id ?? null);
  const viewing = revisions.find((r) => r.id === viewId) ?? current;
  const [edited, setEdited] = useState(viewing?.ai_specification ?? "");

  // Reset the editor when the viewed revision changes (new round, switch iteration).
  useEffect(() => {
    setViewId(current?.id ?? null);
  }, [current?.id]);
  useEffect(() => {
    setEdited(viewing?.ai_specification ?? "");
  }, [viewing?.id, viewing?.ai_specification]);

  return (
    <div className={`${CARD_CLASS} flex flex-col gap-2`}>
      <div className="flex items-center gap-2">
        <Badge tone="accent">AI Specification</Badge>
        {revisions.length > 1 && (
          <Dropdown
            options={revisions.map((r) => ({
              value: String(r.id),
              label: `Iteration ${r.iteration}${r.model_used ? ` · ${r.model_used}` : ""}`,
            }))}
            value={viewing ? String(viewing.id) : undefined}
            onChange={(v) => setViewId(Number(v))}
          />
        )}
        {busy && <span className="text-xs text-amber-600">Ollama working…</span>}
      </div>
      {!viewing ? (
        <p className="py-8 text-center text-sm text-gray-500">
          {busy ? "Generating the first specification…" : "No specification yet."}
        </p>
      ) : (
        <>
          <textarea
            className={`${FIELD_CLASS} min-h-[260px] font-mono text-xs`}
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
          />
          <button
            type="button"
            className={BTN_GHOST_CLASS}
            disabled={edited === viewing.ai_specification}
            onClick={() => onSaveEdit(viewing.id, edited)}
          >
            Save spec edits
          </button>
        </>
      )}
    </div>
  );
}

function EnhanceBar({
  prompts,
  busy,
  onSend,
}: {
  prompts: ForgePrompt[];
  busy: boolean;
  onSend: (req: { promptId?: number; promptText?: string }) => void;
}) {
  const defaultPrompt = prompts.find((p) => p.is_default) ?? prompts[0] ?? null;
  const [promptId, setPromptId] = useState<number | null>(defaultPrompt?.id ?? null);
  const selected = prompts.find((p) => p.id === promptId) ?? defaultPrompt;
  const [text, setText] = useState(selected?.body ?? "");

  // Load the chosen prompt's body into the editor when the selection changes.
  useEffect(() => {
    setText(selected?.body ?? "");
  }, [selected?.id]);

  const send = () => {
    const edited = text.trim();
    // Typed-from-scratch (no prompt selected) → text only. Saved/edited → keep the link.
    onSend({
      promptId: promptId ?? undefined,
      promptText: edited && edited !== selected?.body ? edited : promptId == null ? edited : undefined,
    });
  };

  return (
    <div className={`${CARD_CLASS} flex flex-col gap-2`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Refine with Ollama</span>
        <Dropdown
          options={[
            ...prompts.map((p) => ({ value: String(p.id), label: p.is_default ? `${p.name} (default)` : p.name })),
            { value: "custom", label: "Custom (typed below)" },
          ]}
          value={promptId == null ? "custom" : String(promptId)}
          onChange={(v) => setPromptId(v === "custom" ? null : Number(v))}
        />
        <button type="button" className={`${BTN_PRIMARY_CLASS} ml-auto`} disabled={busy} onClick={send}>
          <IconZap /> {busy ? "Sending…" : "Send to Ollama"}
        </button>
      </div>
      <textarea
        className={`${FIELD_CLASS} min-h-[120px] font-mono text-xs`}
        placeholder="Prompt sent to Ollama. Edit it for this round, or pick a saved prompt above."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="text-xs text-gray-500">
        Tip: each send refines the current best spec. Use Draft status to keep iterating; Ready auto-publishes the next
        result to the queue.
      </p>
    </div>
  );
}

function NewDraftModal({
  onClose,
  onCreate,
  busy,
}: {
  onClose: () => void;
  onCreate: (input: { title: string; raw_content: string; target_status: ForgeTargetStatus }) => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState("");
  const [raw, setRaw] = useState("");
  const [status, setStatus] = useState<ForgeTargetStatus>("draft");

  return (
    <Modal title="New task draft" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Title
          <input className={FIELD_CLASS} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Rough description
          <textarea
            className={`${FIELD_CLASS} min-h-[160px]`}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="Brain-dump the task here. Ollama will turn it into a structured spec."
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Target status
          <Dropdown
            options={FORGE_TARGET_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
            value={status}
            onChange={(v) => setStatus(v as ForgeTargetStatus)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={BTN_PRIMARY_CLASS}
            disabled={busy || !title.trim()}
            onClick={() => onCreate({ title: title.trim(), raw_content: raw, target_status: status })}
          >
            Create &amp; enhance
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PromptManagerModal({ prompts, onClose }: { prompts: ForgePrompt[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const onError = (e: unknown) => notify(e instanceof Error ? e.message : "request failed", "error");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["forge-prompts"] });

  const [editing, setEditing] = useState<ForgePrompt | "new" | null>(null);

  const save = useMutation({
    mutationFn: (p: { id?: number; name: string; body: string; is_default: boolean }) =>
      p.id ? updateForgePrompt(p.id, p) : createForgePrompt(p),
    onSuccess: () => {
      invalidate();
      setEditing(null);
    },
    onError,
  });
  const remove = useMutation({ mutationFn: deleteForgePrompt, onSuccess: invalidate, onError });

  return (
    <Modal title="Refinement prompts" onClose={onClose} widthClass="max-w-2xl">
      {editing ? (
        <PromptForm
          prompt={editing === "new" ? null : editing}
          busy={save.isPending}
          onCancel={() => setEditing(null)}
          onSave={(v) => save.mutate(editing === "new" ? v : { ...v, id: editing.id })}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {prompts.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-md border border-gray-200 p-2 dark:border-gray-700">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  {p.is_default && <Badge tone="accent">default</Badge>}
                </div>
                <p className="truncate text-xs text-gray-500">{p.body}</p>
              </div>
              <button type="button" className={BTN_GHOST_CLASS} onClick={() => setEditing(p)}>
                Edit
              </button>
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                onClick={async () => {
                  if (await confirm({ prompt: `Delete prompt "${p.name}"?`, confirmText: "Delete" })) remove.mutate(p.id);
                }}
              >
                <IconTrash />
              </button>
            </div>
          ))}
          <button type="button" className={`${BTN_PRIMARY_CLASS} self-start`} onClick={() => setEditing("new")}>
            <IconPlus /> New prompt
          </button>
        </div>
      )}
    </Modal>
  );
}

function PromptForm({
  prompt,
  busy,
  onCancel,
  onSave,
}: {
  prompt: ForgePrompt | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (v: { name: string; body: string; is_default: boolean }) => void;
}) {
  const [name, setName] = useState(prompt?.name ?? "");
  const [body, setBody] = useState(prompt?.body ?? "");
  const [isDefault, setIsDefault] = useState(prompt?.is_default ?? false);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input className={FIELD_CLASS} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Prompt body (system instruction sent to Ollama)
        <textarea className={`${FIELD_CLASS} min-h-[220px] font-mono text-xs`} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Use as the default prompt
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" className={BTN_GHOST_CLASS} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={BTN_PRIMARY_CLASS}
          disabled={busy || !name.trim() || !body.trim()}
          onClick={() => onSave({ name: name.trim(), body, is_default: isDefault })}
        >
          Save
        </button>
      </div>
    </div>
  );
}
