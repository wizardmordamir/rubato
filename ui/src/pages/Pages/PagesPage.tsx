import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LayoutView } from "cwip/layout";
import {
  LayoutCanvas,
  LayoutRenderer,
  makeElementNode,
  makeSectionNode,
  NodeInspector,
  useLayoutEditor,
} from "cursedbelt/react";
import { useState } from "react";
import { type CustomPage, deleteCustomPage, fetchCustomPages, saveCustomPage } from "../../api";
import { useConfirm } from "../../confirm";
import {
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_INTERACTIVE_CLASS,
  FIELD_CLASS,
  PageHeading,
} from "../../components";
import { PALETTE, RUBATO_WIDGETS } from "./widgets";

const emptyView = (): LayoutView => ({ enabled: true, nodes: [] });
const qKey = ["custom-pages"] as const;

// /pages — build your own dashboards: a saved layout of widgets you drag onto a
// canvas, persisted in the rubato DB. Built on the shared cwip layout engine; the
// widgets are rubato's own (see ./widgets).
export function PagesPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: pages = [], isLoading } = useQuery({ queryKey: qKey, queryFn: fetchCustomPages });
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: qKey });
  const create = useMutation({
    mutationFn: (title: string) => saveCustomPage({ title, layout: emptyView() }),
    onSuccess: (page) => {
      setNewTitle("");
      invalidate();
      setOpenId(page.id);
      setEditing(true);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteCustomPage(id),
    onSuccess: invalidate,
  });

  const open = openId ? pages.find((p) => p.id === openId) : undefined;

  if (open) {
    return editing ? (
      <PageEditor
        page={open}
        onClose={(saved) => {
          setEditing(false);
          if (saved) invalidate();
        }}
      />
    ) : (
      <PageView page={open} onEdit={() => setEditing(true)} onBack={() => setOpenId(null)} />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeading title="Pages" />
      <p className="-mt-2 text-sm text-gray-500 dark:text-gray-400">
        Build your own dashboards — drag widgets onto a saved layout.
      </p>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newTitle.trim()) create.mutate(newTitle.trim());
        }}
      >
        <input
          className={FIELD_CLASS}
          placeholder="New dashboard name…"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <button type="submit" className={BTN_PRIMARY_CLASS} disabled={!newTitle.trim() || create.isPending}>
          New dashboard
        </button>
      </form>

      {isLoading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : pages.length === 0 ? (
        <p className="text-sm text-gray-400">
          No dashboards yet — name one above and start dragging widgets onto it.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pages.map((p) => (
            <div key={p.id} className={`${CARD_INTERACTIVE_CLASS} flex items-start justify-between gap-2`}>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  setOpenId(p.id);
                  setEditing(false);
                }}
              >
                <div className="truncate font-semibold text-gray-900 dark:text-gray-100">
                  {p.icon ? `${p.icon} ` : ""}
                  {p.title}
                </div>
                {p.description && (
                  <div className="truncate text-sm text-gray-500 dark:text-gray-400">{p.description}</div>
                )}
                <div className="mt-1 text-xs text-gray-400">{p.layout?.nodes?.length ?? 0} widgets</div>
              </button>
              <button
                type="button"
                aria-label="Delete dashboard"
                className="shrink-0 rounded p-1 text-gray-300 hover:text-rose-500"
                onClick={async () => {
                  if (await confirm({ prompt: `Delete "${p.title}"?`, confirmText: "Delete" })) remove.mutate(p.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Read-only render of a saved dashboard.
function PageView({ page, onEdit, onBack }: { page: CustomPage; onEdit: () => void; onBack: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeading
        title={`${page.icon ? `${page.icon} ` : ""}${page.title}`}
        actions={
          <div className="flex gap-2">
            <button type="button" className={BTN_GHOST_CLASS} onClick={onBack}>
              ← All
            </button>
            <button type="button" className={BTN_PRIMARY_CLASS} onClick={onEdit}>
              Edit
            </button>
          </div>
        }
      />
      {page.description && <p className="-mt-2 text-sm text-gray-500 dark:text-gray-400">{page.description}</p>}
      {(page.layout?.nodes?.length ?? 0) === 0 ? (
        <p className="text-sm text-gray-400">This dashboard is empty. Click Edit to add widgets.</p>
      ) : (
        <LayoutRenderer nodes={page.layout.nodes} fields={[]} widgets={RUBATO_WIDGETS} surface="page" />
      )}
    </div>
  );
}

// The drag-and-drop dashboard builder: a widget palette, the shared cwip canvas, and
// the node inspector. Saves the layout (+ title) to the rubato DB.
function PageEditor({ page, onClose }: { page: CustomPage; onClose: (saved: boolean) => void }) {
  const editor = useLayoutEditor({ page: page.layout ?? emptyView() }, { initialTab: "page" });
  const [title, setTitle] = useState(page.title);

  const save = useMutation({
    mutationFn: () =>
      saveCustomPage({
        id: page.id,
        title: title.trim() || page.title,
        icon: page.icon,
        description: page.description,
        layout: editor.payload.page,
      }),
    onSuccess: () => onClose(true),
  });

  const add = (type: string, content?: string) =>
    editor.addNode(
      type === "section" ? makeSectionNode() : makeElementNode(RUBATO_WIDGETS, type, content),
      editor.activeContainerId,
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <input
          className={`${FIELD_CLASS} max-w-xs text-lg font-semibold`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="flex gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => onClose(false)}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {PALETTE.map((w) => (
          <button
            key={w.type}
            type="button"
            className={BTN_GHOST_CLASS}
            onClick={() => add(w.type, w.defaultContent)}
          >
            + {w.title}
          </button>
        ))}
        <div className="ml-auto flex gap-1">
          <button type="button" className={BTN_GHOST_CLASS} onClick={editor.undo} disabled={!editor.canUndo}>
            Undo
          </button>
          <button type="button" className={BTN_GHOST_CLASS} onClick={editor.redo} disabled={!editor.canRedo}>
            Redo
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
          <LayoutCanvas
            nodes={editor.view.nodes}
            fields={[]}
            sampleRow={{}}
            sampleRows={[]}
            surface="page"
            widgets={RUBATO_WIDGETS}
            selectedId={editor.selectedId}
            onSelect={editor.setSelectedId}
            onRemove={editor.removeNode}
            onReorder={editor.reorder}
            emptyHint="Add widgets from the palette above to design this dashboard."
          />
        </div>
        <div className="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
          {editor.selectedNode ? (
            <NodeInspector
              node={editor.selectedNode}
              fields={[]}
              widgets={RUBATO_WIDGETS}
              sections={editor.sections}
              currentContainerId={editor.selectedContainer}
              onMove={(containerId) => editor.selectedNode && editor.moveNode(editor.selectedNode.id, containerId)}
              onChange={(patch) => editor.selectedNode && editor.updateNode(editor.selectedNode.id, patch)}
            />
          ) : (
            <p className="text-sm text-gray-400">Select a widget to edit it.</p>
          )}
        </div>
      </div>
    </div>
  );
}
