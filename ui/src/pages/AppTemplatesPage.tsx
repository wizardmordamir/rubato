import { normalizeHomedir, parseTemplateEntries } from "@shared/appsTemplate";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AddItemsMenu, DismissButton, JsonEditor, useDismissibleItems } from "cwip/react";
import { useMemo, useState } from "react";
import {
  addAppsToTemplate,
  type AppConfig,
  applyTemplateEntries,
  commitTemplate,
  createTemplateEntries,
  editTemplateEntry,
  fetchApps,
  fetchAppsTemplate,
  fetchAppsTemplateDiff,
  removeTemplateEntries,
  setHiddenTemplates,
  sortTemplate,
  type TemplateEntry,
  type TemplateEntryStatus,
  type TemplateGit,
} from "../api";
import {
  Badge,
  BTN_GHOST_CLASS,
  Alert,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  FIELD_CLASS,
  InfoHint,
  PageHeading,
  PathRef,
  SearchInput,
  Tooltip,
} from "../components";
import { useConfirm } from "../confirm";
import { DiffViewer } from "../DiffViewer";
import { IconPlus, IconTrash } from "../icons";
import { Modal } from "../Modal";
import { useToast } from "../toast";

/** Starter text for a new entry — invalid until `name` is filled, so Save stays off. */
const NEW_ENTRY_STUB = `{
  "name": "",
  "aliases": [],
  "absolutePath": "<HOME>/"
}`;

/** Stable adapter so cwip's <JsonEditor> shows template-level validity (name/path
 *  required), not just generic JSON validity. Module-scope = stable identity. */
const parseEntriesForEditor = (text: string) => {
  const r = parseTemplateEntries(text);
  return { ok: r.ok, value: r.entries, error: r.error };
};

/** Summarize an apply/add/remove result into one toast line. */
function summarize(verb: string, names: string[], skipped?: { name: string; reason: string }[]): string {
  const head = names.length ? `${verb} ${names.length}: ${names.join(", ")}` : `Nothing to ${verb.toLowerCase()}`;
  if (skipped?.length) return `${head} · skipped ${skipped.length} (${skipped.map((s) => s.name).join(", ")})`;
  return head;
}

/**
 * "Commit the template" nudge. When edits made through this page leave the
 * git-tracked `apps.template.json` dirty, show an amber banner whose action opens
 * the review-and-commit modal — so you eyeball the actual diff before committing
 * (rather than committing blind). Committing is local only; the user still pushes
 * to share. When the file isn't under git, a muted note explains why no commit is
 * offered.
 */
function CommitBanner({ git, onCommitted }: { git: TemplateGit; onCommitted: () => void }) {
  const [reviewing, setReviewing] = useState(false);

  if (!git.inRepo) {
    return (
      <p className="mb-3 text-xs text-gray-400">
        The template file isn't in a git repo here, so it can't be committed or synced from rubato.
      </p>
    );
  }
  if (!git.dirty) return null;

  return (
    <>
      <Alert
        tone="warning"
        className="mb-3"
        actions={
          <Tooltip
            multiline
            content="Open a diff viewer showing exactly what changed in apps.template.json since the last commit, then commit it from there. Lets you eyeball the change instead of committing blind."
          >
            <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => setReviewing(true)}>
              Review &amp; commit
            </button>
          </Tooltip>
        }
      >
        Uncommitted template changes ({git.state}) — review the diff, then commit so your other machines can pull the
        new defaults.
      </Alert>
      {reviewing && (
        <TemplateDiffModal
          state={git.state}
          onClose={() => setReviewing(false)}
          onCommitted={() => {
            setReviewing(false);
            onCommitted();
          }}
        />
      )}
    </>
  );
}

/**
 * Review-then-commit modal: shows the unified diff of `apps.template.json` (exactly
 * what a commit would record) in a GitHub-style viewer, with an optional commit
 * message and the commit button right there — so the change is reviewed in the UI
 * before it's committed. Refetches the diff each open so it's always current.
 */
function TemplateDiffModal({
  state,
  onClose,
  onCommitted,
}: {
  state: TemplateGit["state"];
  onClose: () => void;
  onCommitted: () => void;
}) {
  const { notify } = useToast();
  const [message, setMessage] = useState("");
  const diffQuery = useQuery({
    queryKey: ["apps-template-diff"],
    queryFn: fetchAppsTemplateDiff,
    refetchOnMount: "always",
  });

  const commit = useMutation({
    mutationFn: () => commitTemplate(message.trim() || undefined),
    onSuccess: (r) => {
      if (r.ok && r.committed) {
        notify("Committed apps.template.json — push to share it with other machines", "success");
        onCommitted();
      } else if (r.ok) {
        notify(r.output ?? "Nothing to commit", "success");
        onCommitted();
      } else {
        notify(r.error ?? "commit failed", "error");
      }
    },
    onError: (e) => notify(e instanceof Error ? e.message : "commit failed", "error"),
  });

  return (
    <Modal title="Review template changes" onClose={onClose} widthClass="max-w-3xl">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {state === "untracked"
            ? "New file — every line will be added."
            : "Changes since the last commit of apps.template.json."}{" "}
          Committing is local only; push to share with your other machines.
        </p>

        {diffQuery.isLoading ? (
          <p className="text-xs text-gray-400">loading diff…</p>
        ) : diffQuery.isError ? (
          <p className="text-xs text-rose-500">Couldn't load the diff.</p>
        ) : (
          <DiffViewer diff={diffQuery.data?.diff ?? ""} />
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
          <input
            type="text"
            className={`${FIELD_CLASS} min-w-0 flex-1`}
            placeholder="chore(apps): update apps.template.json"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            aria-label="Commit message"
          />
          <button type="button" className={BTN_GHOST_CLASS} onClick={onClose} disabled={commit.isPending}>
            Cancel
          </button>
          <Tooltip
            multiline
            content="Commit apps.template.json with the message above. This is a local git commit only — push the repo separately to share the new defaults with your other machines."
          >
            <button
              type="button"
              className={BTN_PRIMARY_CLASS}
              disabled={commit.isPending || diffQuery.isLoading}
              onClick={() => commit.mutate()}
            >
              {commit.isPending ? "Committing…" : "Commit template"}
            </button>
          </Tooltip>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Add-or-edit a template entry from pasted JSON / JS. The cwip <JsonEditor> shows
 * live template-level validity (name + absolutePath required) and a "Format → JSON"
 * action; on save the parsed entries go to the server, which normalizes paths,
 * conflict-checks, and warns (never blocks) on a missing on-disk path. New mode
 * accepts an array to add several at once; edit mode replaces one entry in place.
 */
function EntryEditorModal({
  mode,
  initial,
  existingNames,
  onClose,
  onSaved,
}: {
  mode: "new" | "edit";
  initial?: TemplateEntry;
  existingNames: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { notify } = useToast();
  const [text, setText] = useState(() =>
    mode === "edit" && initial ? JSON.stringify(initial, null, 2) : NEW_ENTRY_STUB,
  );
  const parsed = useMemo(() => parseTemplateEntries(text), [text]);
  const entries = parsed.ok ? (parsed.entries ?? []) : [];

  // Client-side name-conflict hint (the server is authoritative). In edit mode the
  // entry's own original name is allowed.
  const conflicts = useMemo(() => {
    const taken = new Set(existingNames.map((n) => n.toLowerCase()));
    if (mode === "edit" && initial) taken.delete(initial.name.toLowerCase());
    return entries.filter((e) => taken.has(e.name.toLowerCase())).map((e) => e.name);
  }, [entries, existingNames, mode, initial]);

  const create = useMutation({
    mutationFn: (list: TemplateEntry[]) => createTemplateEntries(list),
    onSuccess: (r) => {
      onSaved();
      if (r.added.length) {
        const warn = r.missingPaths.length ? ` · path not found: ${r.missingPaths.join(", ")}` : "";
        notify(`Added ${r.added.join(", ")}${warn}`, r.missingPaths.length ? "warning" : "success");
      }
      if (r.skipped.length) {
        notify(`Skipped ${r.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`, "error");
      }
      if (r.added.length) onClose();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "add failed", "error"),
  });

  const edit = useMutation({
    mutationFn: (entry: TemplateEntry) => editTemplateEntry(initial?.name ?? entry.name, entry),
    onSuccess: (r) => {
      if (!r.ok) {
        notify(r.error ?? "edit failed", "error");
        return;
      }
      onSaved();
      const warn = r.pathExists === false ? " · path not found on this machine" : "";
      notify(`Saved ${r.updated}${warn}`, r.pathExists === false ? "warning" : "success");
      onClose();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "edit failed", "error"),
  });

  const busy = create.isPending || edit.isPending;
  // New: allow save even with some name clashes (the server skips those). Edit:
  // block a rename onto a different existing entry.
  const canSave = parsed.ok && entries.length > 0 && !busy && (mode === "new" || conflicts.length === 0);

  const save = () => {
    if (!parsed.ok || entries.length === 0) return;
    if (mode === "edit") edit.mutate(entries[0]);
    else create.mutate(entries);
  };

  return (
    <Modal
      title={mode === "edit" ? `Edit ${initial?.name ?? "entry"}` : "New template entry"}
      onClose={onClose}
      widthClass="max-w-xl"
    >
      <p className="mb-2 text-xs text-gray-400">
        Paste a JSON or JS object — single quotes, unquoted keys, trailing commas, and{" "}
        <span className="font-mono">{"${homedir()}"}</span> are all accepted and converted to clean JSON with{" "}
        <span className="font-mono">&lt;HOME&gt;</span>.{mode === "new" && " Paste an array to add several at once."}
      </p>
      <JsonEditor
        value={text}
        onChange={setText}
        parse={parseEntriesForEditor}
        normalize={normalizeHomedir}
        rows={mode === "edit" ? 10 : 12}
        autoFocus
        formatLabel="Format → JSON"
      />
      {parsed.ok && entries.length > 0 && (
        <p className="mt-2 text-xs text-gray-500">
          {entries.length} {entries.length === 1 ? "entry" : "entries"} ready
          {mode === "edit" && entries.length > 1 && " — only the first is used when editing"}
        </p>
      )}
      {conflicts.length > 0 && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          Already in the template: {conflicts.join(", ")} —{" "}
          {mode === "edit" ? "choose another name" : "these will be skipped"}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={BTN_GHOST_CLASS} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={BTN_PRIMARY_CLASS} disabled={!canSave} onClick={save}>
          {busy ? "Saving…" : mode === "edit" ? "Save changes" : "Add to template"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * App-template manager (`/apps/templates`). Over the shared, repo-tracked
 * `apps.template.json` you can:
 *   1. **Author** — add new entries (paste JSON/JS), edit an entry in place, and
 *      sort the file alphabetically.
 *   2. **Apply** — see each entry's applied / path-exists status for this machine,
 *      then add the not-yet-applied ones to `~/.rubato/apps.json`.
 *   3. **Hide per-machine** — "✕" an entry to hide it on THIS machine (stored in
 *      config, not the shared file); bring it back via "Show hidden".
 *   4. **Contribute** — push existing registry apps into the template.
 */
export function AppTemplatesPage() {
  const qc = useQueryClient();
  const { notify } = useToast();

  const { data: status, isLoading } = useQuery({ queryKey: ["apps-template"], queryFn: fetchAppsTemplate });
  const { data: apps = [] } = useQuery({ queryKey: ["apps"], queryFn: fetchApps });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["apps-template"] });
    qc.invalidateQueries({ queryKey: ["apps"] });
    qc.invalidateQueries({ queryKey: ["apps-template-diff"] });
  };

  const apply = useMutation({
    mutationFn: (names: string[]) => applyTemplateEntries(names),
    onSuccess: (r) => {
      invalidate();
      setSelected(new Set());
      notify(summarize("Added", r.added, r.skipped), r.added.length ? "success" : "error");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "apply failed", "error"),
  });

  const remove = useMutation({
    mutationFn: (name: string) => removeTemplateEntries([name]),
    onSuccess: (r) => {
      invalidate();
      notify(summarize("Removed", r.removed), "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "remove failed", "error"),
  });

  const sort = useMutation({
    mutationFn: () => sortTemplate(),
    onSuccess: () => {
      invalidate();
      notify("Sorted entries A–Z", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "sort failed", "error"),
  });

  // Per-machine hide/restore — persisted in ~/.rubato/config.json (not the shared
  // file). Controlled by `status.hidden`; the cwip primitives own the UI.
  const setHidden = useMutation({
    mutationFn: (names: string[]) => setHiddenTemplates(names),
    onSuccess: () => invalidate(),
    onError: (e) => notify(e instanceof Error ? e.message : "could not update hidden set", "error"),
  });

  // null = closed; otherwise the new/edit editor modal.
  const [editor, setEditor] = useState<{ mode: "new" } | { mode: "edit"; entry: TemplateEntry } | null>(null);

  const entries = status?.entries ?? [];
  const {
    visible,
    hiddenItems,
    hide,
    restore,
  } = useDismissibleItems({
    items: entries,
    itemKey: (e) => e.entry.name,
    hidden: status?.hidden ?? [],
    onHiddenChange: (next) => setHidden.mutate(next),
  });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return visible;
    return visible.filter((e) =>
      [e.entry.name, e.entry.group, e.resolvedPath, ...(e.entry.aliases ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [visible, q]);

  const notApplied = filtered.filter((e) => !e.applied);
  const allSelectable = notApplied.map((e) => e.entry.name);
  const allSelected = allSelectable.length > 0 && allSelectable.every((n) => selected.has(n));

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeading
        title="App templates"
        count={entries.length}
        actions={
          <>
            <Tooltip
              multiline
              content="Add one or more app entries to the shared template by pasting a JSON/JS object (or array). Each entry describes an app's name, portable path, and metadata; it's added to apps.template.json, not yet applied to this machine."
            >
              <button
                type="button"
                className={BTN_PRIMARY_CLASS}
                onClick={() => setEditor({ mode: "new" })}
              >
                <IconPlus size={14} /> New entry
              </button>
            </Tooltip>
            <Tooltip multiline content="Reorder every entry in apps.template.json alphabetically by name and save the file. Changes the file, so it shows up as an uncommitted change to review.">
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                disabled={entries.length < 2 || sort.isPending}
                onClick={() => sort.mutate()}
              >
                {sort.isPending ? "Sorting…" : "Sort A–Z"}
              </button>
            </Tooltip>
          </>
        }
      />

      <p className="mb-2 text-xs text-gray-400">
        A shared, git-tracked list of app entries you fill in once and apply on every machine. Paths use{" "}
        <span className="font-mono">&lt;HOME&gt;</span> (e.g. <span className="font-mono">&lt;HOME&gt;/.zshrc</span>) so
        the same entry resolves against each machine's home dir. Commit{" "}
        {status?.path ? <PathRef path={status.path} /> : <span className="font-mono">apps.template.json</span>} and{" "}
        <span className="font-mono">git pull</span> it elsewhere; entries already in this machine's registry are marked{" "}
        <span className="text-emerald-600 dark:text-emerald-400">applied</span>.
      </p>

      {status?.git && <CommitBanner git={status.git} onCommitted={invalidate} />}

      {isLoading ? (
        <p className="text-gray-400">loading…</p>
      ) : !status?.exists && entries.length === 0 ? (
        <div className={`${CARD_CLASS} p-4 text-sm text-gray-500`}>
          No template yet. Add apps to it below — that creates{" "}
          <span className="font-mono">{status?.path ?? "apps.template.json"}</span>, which you then commit so it syncs to
          your other machines.
        </div>
      ) : (
        <>
          <div className="mb-2 mt-3">
            <SearchInput value={q} onChange={setQ} />
          </div>

          {/* Bulk actions for the not-yet-applied entries + restore-hidden menu. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-gray-500">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={allSelectable.length === 0}
                onChange={(e) => setSelected(e.target.checked ? new Set(allSelectable) : new Set())}
              />
              Select all not-applied ({allSelectable.length})
            </label>
            <div className="ml-auto flex items-center gap-2">
              {hiddenItems.length > 0 && (
                <AddItemsMenu
                  label="Show hidden"
                  showCount
                  icon={<IconPlus size={14} />}
                  items={hiddenItems}
                  itemKey={(e) => e.entry.name}
                  itemLabel={(e) => e.entry.name}
                  itemDescription={(e) => e.entry.absolutePath}
                  onAdd={(e) => restore(e.entry.name)}
                />
              )}
              <Tooltip
                multiline
                content="Apply the selected (not-yet-applied) template entries to THIS machine — writes them into ~/.rubato/apps.json so the apps appear in your local registry. Doesn't change the shared template file."
              >
                <button
                  type="button"
                  className={BTN_PRIMARY_CLASS}
                  disabled={selected.size === 0 || apply.isPending}
                  onClick={() => apply.mutate([...selected])}
                >
                  <IconPlus size={14} /> {apply.isPending ? "Adding…" : `Add ${selected.size || ""} to registry`}
                </button>
              </Tooltip>
            </div>
          </div>

          <ul className="space-y-2">
            {filtered.map((e) => (
              <TemplateRow
                key={e.entry.name}
                status={e}
                checked={selected.has(e.entry.name)}
                onToggle={() => toggle(e.entry.name)}
                onEdit={() => setEditor({ mode: "edit", entry: e.entry })}
                onHide={() => hide(e.entry.name)}
                onRemove={() => remove.mutate(e.entry.name)}
                removing={remove.isPending}
              />
            ))}
            {filtered.length === 0 && <li className="text-gray-400">no matches</li>}
          </ul>
        </>
      )}

      <AddToTemplatePanel apps={apps} inTemplate={new Set(entries.map((e) => e.entry.name))} onChanged={invalidate} />

      {editor && (
        <EntryEditorModal
          mode={editor.mode}
          initial={editor.mode === "edit" ? editor.entry : undefined}
          existingNames={entries.map((e) => e.entry.name)}
          onClose={() => setEditor(null)}
          onSaved={invalidate}
        />
      )}
    </div>
  );
}

/** One template entry: selection checkbox, identity, paths, status badges, and
 *  per-row actions (edit, hide-on-this-machine, delete-from-file). */
function TemplateRow({
  status,
  checked,
  onToggle,
  onEdit,
  onHide,
  onRemove,
  removing,
}: {
  status: TemplateEntryStatus;
  checked: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onHide: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const confirm = useConfirm();
  const { entry, resolvedPath, applied, appliedPath, pathMismatch, pathExists } = status;
  return (
    <li className={`${CARD_CLASS} flex items-start gap-3 p-3`}>
      <Tooltip content={applied ? "Already in this machine's registry" : "Select to add to the registry"}>
        <input
          type="checkbox"
          className="mt-1"
          checked={checked}
          disabled={applied}
          aria-label={applied ? "Already in this machine's registry" : "Select to add to the registry"}
          onChange={onToggle}
        />
      </Tooltip>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{entry.name}</span>
          {entry.group && <span className="text-xs text-gray-400">/ {entry.group}</span>}
          {applied ? <Badge tone="success">applied</Badge> : <Badge tone="neutral">not applied</Badge>}
          {pathExists ? <Badge tone="success">path exists</Badge> : <Badge tone="error">path missing</Badge>}
          {pathMismatch && <Badge tone="error">path differs</Badge>}
          <InfoHint title="Entry status" align="right">
            <span className="font-semibold">applied</span> = already in this machine's registry (apps.json).{" "}
            <span className="font-semibold">path exists / missing</span> = whether the entry's resolved path is present on
            this machine right now. <span className="font-semibold">path differs</span> = it's applied, but the registry
            points at a different path than the template's.
          </InfoHint>
        </div>
        {(entry.aliases?.length || (entry.apis as { name: string }[])?.length) && (
          <div className="my-1.5 flex flex-wrap items-center gap-1">
            {(entry.aliases ?? []).map((x) => (
              <Badge key={x} tone="neutral">
                {x}
              </Badge>
            ))}
            {((entry.apis as { name: string }[]) ?? []).map((api) => (
              <Badge key={api.name} tone="accent">
                {api.name}
              </Badge>
            ))}
            <InfoHint title="Aliases & APIs" align="right">
              Gray chips are <span className="font-semibold">aliases</span> — alternate names this app can be invoked by.
              Accent chips are named <span className="font-semibold">APIs</span> defined on the entry.
            </InfoHint>
          </div>
        )}
        <div className="font-mono text-xs text-gray-500">{entry.absolutePath}</div>
        <div className="flex items-center gap-1 font-mono text-xs text-gray-400">
          → {resolvedPath}
          <PathRef path={resolvedPath} codeClassName="sr-only" />
        </div>
        {pathMismatch && appliedPath && (
          <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            registry points at <span className="font-mono">{appliedPath}</span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Tooltip content="Edit this entry">
          <button
            type="button"
            className={BTN_GHOST_CLASS}
            aria-label={`Edit ${entry.name}`}
            onClick={onEdit}
          >
            Edit
          </button>
        </Tooltip>
        <DismissButton
          label={`Hide ${entry.name} on this machine`}
          title="Hide on this machine (not removed from the shared file)"
          onClick={onHide}
        />
        <Tooltip
          multiline
          content="Remove this entry from the shared apps.template.json. Unlike hide, this edits the committed file — once you commit and others pull, the entry is gone everywhere. It does not uninstall the app from any machine's registry."
        >
          <button
            type="button"
            className="icon-btn"
            aria-label={`Delete ${entry.name} from the template file`}
            disabled={removing}
            onClick={async () => {
              if (
                await confirm({
                  prompt: `Remove "${entry.name}" from the template?`,
                  flavorText: "This edits the shared apps.template.json — once committed and pulled, it's removed everywhere.",
                  confirmText: "Remove",
                })
              )
                onRemove();
            }}
          >
            <IconTrash size={14} />
          </button>
        </Tooltip>
      </div>
    </li>
  );
}

/**
 * Collapsible "add existing registry apps into the template" picker. Marks apps
 * already in the template, and flags ones outside the home dir (their path can't
 * be made portable with `<HOME>`).
 */
function AddToTemplatePanel({
  apps,
  inTemplate,
  onChanged,
}: {
  apps: AppConfig[];
  inTemplate: Set<string>;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");

  const add = useMutation({
    mutationFn: (names: string[]) => addAppsToTemplate(names),
    onSuccess: (r) => {
      onChanged();
      setPicked(new Set());
      notify(summarize("Saved", r.added), r.added.length ? "success" : "error");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return apps.filter((a) =>
      !needle ? true : [a.name, a.group, a.dirName, ...(a.aliases ?? [])].join(" ").toLowerCase().includes(needle),
    );
  }, [apps, q]);

  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  return (
    <div className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-800">
      <button type="button" className={BTN_GHOST_CLASS} onClick={() => setOpen((v) => !v)}>
        {open ? "▾ Add apps to template" : "▸ Add apps to template"}
      </button>
      {open && (
        <div className="mt-2">
          <p className="mb-2 text-xs text-gray-400">
            Pick registry apps to save into the template (their paths under your home dir become{" "}
            <span className="font-mono">&lt;HOME&gt;/…</span>). Re-adding an app refreshes its entry.
          </p>
          <div className="mb-2">
            <SearchInput value={q} onChange={setQ} />
          </div>
          <div className="mb-2 flex items-center gap-2">
            <Tooltip
              multiline
              content="Write the picked registry apps into the shared template, converting their under-home paths to portable <HOME>/… form. Re-adding an app refreshes its template entry. Commit the file afterward to share it."
            >
              <button
                type="button"
                className={BTN_PRIMARY_CLASS}
                disabled={picked.size === 0 || add.isPending}
                onClick={() => add.mutate([...picked])}
              >
                {add.isPending ? "Saving…" : `Add ${picked.size || ""} to template`}
              </button>
            </Tooltip>
          </div>
          <ul className="max-h-96 space-y-1 overflow-auto">
            {filtered.map((a) => {
              const already = inTemplate.has(a.name);
              const outsideHome = !/^(\/Users\/[^/]+|\/home\/[^/]+|~)(\/|$)/.test(a.absolutePath);
              return (
                <li key={a.absolutePath} className="flex items-center gap-2 rounded px-1 py-1 text-sm">
                  <input type="checkbox" checked={picked.has(a.name)} onChange={() => toggle(a.name)} />
                  <span className="font-medium">{a.name}</span>
                  {a.group && <span className="text-xs text-gray-400">/ {a.group}</span>}
                  {already && <Badge tone="accent">in template</Badge>}
                  {outsideHome && <Badge tone="neutral">outside home</Badge>}
                  <span className="ml-auto truncate font-mono text-xs text-gray-400">{a.absolutePath}</span>
                </li>
              );
            })}
            {filtered.length === 0 && <li className="text-gray-400">no apps</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
