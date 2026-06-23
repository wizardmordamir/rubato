import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { deleteLink, fetchLinks, importBookmarks, type LinkItem, type LinkItemInput, saveLink } from "../api";
import { Alert, Badge, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, PageHeading, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { IconExternal, IconPlus, IconSearch, IconTrash } from "../icons";
import { Modal } from "../Modal";
import { useToast } from "../toast";

/**
 * Links — a searchable catalogue of URLs. Add by hand (title/url/description/
 * folder/tags/notes) or import a browser bookmarks export. The single-user
 * sibling of cursedalchemy's `/links`.
 */

const IMPORT_TIP =
  "Pick a browser bookmarks export (bookmarks.html from Chrome, Edge, Firefox, or Safari). Each bookmark is added with its folder path and tagged \"imported\"; links you already have are skipped, since URLs are deduplicated.";

export function LinksPage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const { data: links = [], isLoading } = useQuery({ queryKey: ["links"], queryFn: fetchLinks });
  const fileRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [editing, setEditing] = useState<LinkItem | "new" | null>(null);
  const confirm = useConfirm();

  const invalidate = () => qc.invalidateQueries({ queryKey: ["links"] });
  const onError = (e: unknown) => notify(e instanceof Error ? e.message : "request failed", "error");

  const save = useMutation({ mutationFn: saveLink, onSuccess: invalidate, onError });
  const remove = useMutation({ mutationFn: deleteLink, onSuccess: invalidate, onError });
  const importMut = useMutation({
    mutationFn: importBookmarks,
    onSuccess: (r) => {
      notify(`Imported ${r.imported} link(s)${r.skipped ? `, skipped ${r.skipped} already saved` : ""}`, "success");
      invalidate();
    },
    onError,
  });

  // Every distinct tag, for the filter chips.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const l of links) for (const t of l.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [links]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return links.filter((l) => {
      if (activeTag && !l.tags.includes(activeTag)) return false;
      if (!q) return true;
      return [l.title, l.url, l.description, l.notes, l.folder, l.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [links, search, activeTag]);

  const onPickFile = async (file: File) => importMut.mutate(await file.text());

  return (
    <div className="flex h-full flex-col">
      <PageHeading
        title="Links"
        count={links.length}
        actions={
          <>
            <Tooltip multiline content={IMPORT_TIP}>
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                disabled={importMut.isPending}
                onClick={() => fileRef.current?.click()}
              >
                {importMut.isPending ? "Importing…" : "Import bookmarks"}
              </button>
            </Tooltip>
            <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => setEditing("new")}>
              <IconPlus /> Add link
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".html,text/html"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPickFile(f);
                e.target.value = "";
              }}
            />
          </>
        }
        toolbar={
          <>
            <div className="relative grow sm:max-w-md">
              <IconSearch className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search links…"
                className={`${FIELD_CLASS} pl-9`}
              />
            </div>
            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <TagChip label="All" active={activeTag === null} onClick={() => setActiveTag(null)} />
                {allTags.map((t) => (
                  <TagChip
                    key={t}
                    label={t}
                    active={activeTag === t}
                    onClick={() => setActiveTag((cur) => (cur === t ? null : t))}
                  />
                ))}
              </div>
            )}
          </>
        }
      />

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : links.length === 0 ? (
        <div className={`${CARD_CLASS} flex flex-col items-center gap-3 p-10 text-center`}>
          <IconExternal className="text-3xl text-gray-400" />
          <div>
            <p className="font-medium">No links yet</p>
            <p className="text-sm text-gray-500">Import your browser bookmarks or add a link by hand.</p>
          </div>
          <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => setEditing("new")}>
            <IconPlus /> Add a link
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {visible.map((link) => (
            <LinkCard
              key={link.id}
              link={link}
              onEdit={() => setEditing(link)}
              onDelete={async () => {
                if (await confirm({ prompt: `Delete "${link.title || link.url}"?`, confirmText: "Delete" }))
                  remove.mutate(link.id);
              }}
            />
          ))}
          {visible.length === 0 && <p className="text-sm text-gray-500">No links match your search.</p>}
        </div>
      )}

      {editing && (
        <LinkEditor
          link={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(input, id) => {
            save.mutate({ ...input, id });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function TagChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition pointer-coarse:min-h-9 ${
        active
          ? "border-accent bg-accent text-white"
          : "border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
      }`}
    >
      {label}
    </button>
  );
}

function LinkCard({ link, onEdit, onDelete }: { link: LinkItem; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className={`${CARD_CLASS} flex flex-col gap-1.5 p-4`}>
      <div className="flex items-start justify-between gap-2">
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-1.5 font-medium text-accent hover:underline"
        >
          {link.favicon ? (
            <img src={link.favicon} alt="" className="h-4 w-4 shrink-0 rounded-sm" />
          ) : (
            <IconExternal className="shrink-0 text-gray-400" />
          )}
          <span className="truncate">{link.title || link.url}</span>
        </a>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className={`${BTN_GHOST_CLASS} px-2 py-1`} onClick={onEdit}>
            Edit
          </button>
          <Tooltip content="Delete link">
            <button
              type="button"
              className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30"
              onClick={onDelete}
            >
              <IconTrash />
            </button>
          </Tooltip>
        </div>
      </div>
      <a href={link.url} target="_blank" rel="noreferrer" className="truncate text-xs text-gray-400 hover:underline">
        {link.url}
      </a>
      {link.description && <p className="text-sm text-gray-600 dark:text-gray-300">{link.description}</p>}
      {link.notes && <p className="whitespace-pre-wrap text-xs text-gray-500">{link.notes}</p>}
      {(link.folder || link.tags.length > 0) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {link.folder && <span className="text-xs text-gray-400">📁 {link.folder}</span>}
          {link.tags.map((t) => (
            <Badge key={t} tone="accent">
              {t}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkEditor({
  link,
  onClose,
  onSave,
}: {
  link: LinkItem | null;
  onClose: () => void;
  onSave: (input: LinkItemInput, id?: string) => void;
}) {
  const [url, setUrl] = useState(link?.url ?? "");
  const [title, setTitle] = useState(link?.title ?? "");
  const [description, setDescription] = useState(link?.description ?? "");
  const [folder, setFolder] = useState(link?.folder ?? "");
  const [tags, setTags] = useState((link?.tags ?? []).join(", "));
  const [notes, setNotes] = useState(link?.notes ?? "");
  const [error, setError] = useState("");

  const submit = () => {
    if (!url.trim()) {
      setError("A URL is required.");
      return;
    }
    onSave(
      {
        url: url.trim(),
        title: title.trim(),
        description: description.trim(),
        folder: folder.trim(),
        notes: notes.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      },
      link?.id,
    );
  };

  return (
    <Modal title={link ? "Edit link" : "Add link"} onClose={onClose} widthClass="max-w-xl">
      <div className="flex flex-col gap-3">
        {error && (
          <Alert tone="error">
            {error}
          </Alert>
        )}
        <Field label="URL">
          <input className={FIELD_CLASS} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </Field>
        <Field label="Title">
          <input className={FIELD_CLASS} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        </Field>
        <Field label="Description">
          <input
            className={FIELD_CLASS}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short description"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Folder">
            <input
              className={FIELD_CLASS}
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="e.g. Dev / Tools"
            />
          </Field>
          <Field label="Tags (comma-separated)">
            <input
              className={FIELD_CLASS}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="ref, docs"
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className={FIELD_CLASS} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY_CLASS} onClick={submit}>
            {link ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-gray-700 dark:text-gray-300">{label}</span>
      {children}
    </label>
  );
}
