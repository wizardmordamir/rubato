import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  applyShellAliases,
  createShellAlias,
  deleteShellAlias,
  fetchShellAliases,
  fetchShellConfigs,
  importShellAliasesFromJson,
  type ShellAlias,
  type ShellAliasInput,
  updateShellAlias,
} from "../api";
import {
  Badge,
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  FIELD_CLASS,
  PageHeading,
  Tooltip,
} from "../components";
import { useConfirm } from "../confirm";
import { IconClipboard, IconFileText, IconPlay, IconPlus, IconSearch, IconTerminal, IconTrash } from "../icons";
import { Modal } from "../Modal";
import { useToast } from "../toast";

const ALIAS_KEY = ["shell-aliases"];
const CONFIG_KEY = ["shell-configs"];

const parseTags = (raw: string) =>
  raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

// ── Alias edit modal ──────────────────────────────────────────────────────────

interface AliasModalProps {
  initial?: Partial<ShellAliasInput>;
  onClose: () => void;
  onSave: (v: ShellAliasInput) => void;
  saving: boolean;
}

function AliasModal({ initial = {}, onClose, onSave, saving }: AliasModalProps) {
  const [name, setName] = useState(initial.name ?? "");
  const [command, setCommand] = useState(initial.command ?? "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [tags, setTags] = useState(initial.tags ?? "");
  const valid = name.trim() && command.trim();

  return (
    <Modal title={initial.name ? "Edit alias" : "New alias"} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium">
            Name <span className="text-red-500">*</span>
          </label>
          <input
            className={FIELD_CLASS}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. gs"
            autoFocus
          />
          <p className="mt-1 text-xs text-gray-500">The short name you type in the terminal.</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">
            Command <span className="text-red-500">*</span>
          </label>
          <input
            className={FIELD_CLASS}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="e.g. git status"
          />
          <p className="mt-1 text-xs text-gray-500">What the alias expands to.</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Description</label>
          <input
            className={FIELD_CLASS}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this alias do?"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Tags</label>
          <input
            className={FIELD_CLASS}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="git, nav, work (comma-separated)"
          />
        </div>
        <div className="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
          <button type="button" className={BTN_GHOST_CLASS} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={BTN_PRIMARY_CLASS}
            onClick={() => onSave({ name: name.trim(), command, description, tags })}
            disabled={!valid || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Shell config setup panel ──────────────────────────────────────────────────

function SetupPanel({ onClose }: { onClose: () => void }) {
  const { notify } = useToast();
  const { data: cfg } = useQuery({ queryKey: CONFIG_KEY, queryFn: fetchShellConfigs });
  const [selected, setSelected] = useState<string>("");
  const [applying, setApplying] = useState(false);

  const apply = async () => {
    setApplying(true);
    try {
      const res = await applyShellAliases(selected || undefined);
      notify(
        `Wrote ${res.applied} alias(es) to ${res.aliasFile}${selected ? ` and added source line to ~/${selected}` : ""}`,
        "success",
      );
      onClose();
    } catch {
      notify("Apply failed", "error");
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal title="Apply to shell config" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Your aliases will be written to <code className="text-xs">~/.rubato-user-aliases.sh</code>.
          Optionally choose a shell config file to source it from automatically.
        </p>
        {cfg && (
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Source from (optional)</label>
            <select
              className={FIELD_CLASS}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Just write the file (don't add source line)</option>
              {cfg.configs.map((c) => (
                <option key={c.file} value={c.file}>
                  {c.label} {c.exists ? "" : "(will create)"}
                </option>
              ))}
            </select>
            {cfg.aliasFileExists && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                ⚠ {cfg.aliasFile} already exists and will be overwritten.
              </p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
          <button type="button" className={BTN_GHOST_CLASS} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY_CLASS} onClick={apply} disabled={applying}>
            {applying ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ShellAliasesPage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: aliases = [], isLoading } = useQuery({
    queryKey: ALIAS_KEY,
    queryFn: fetchShellAliases,
  });

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ShellAlias | "new" | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ALIAS_KEY });
  const onError = (e: unknown) => notify(e instanceof Error ? e.message : "request failed", "error");

  const create = useMutation({ mutationFn: (v: ShellAliasInput) => createShellAlias(v), onSuccess: invalidate, onError });
  const update = useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<ShellAliasInput>) => updateShellAlias(id, patch),
    onSuccess: invalidate,
    onError,
  });
  const remove = useMutation({ mutationFn: deleteShellAlias, onSuccess: invalidate, onError });
  const importMut = useMutation({
    mutationFn: (data: { aliases: { name: string; command: string; description?: string; tags?: string }[] }) =>
      importShellAliasesFromJson(data.aliases),
    onSuccess: (r) => {
      notify(`Imported ${r.imported} alias(es)${r.skipped ? `, skipped ${r.skipped}` : ""}`, "success");
      invalidate();
    },
    onError,
  });

  const visible = (() => {
    const q = search.trim().toLowerCase();
    if (!q) return aliases;
    return aliases.filter((a) =>
      [a.name, a.command, a.description, a.tags].join(" ").toLowerCase().includes(q),
    );
  })();

  const onPickFile = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data?.aliases)) {
        notify("File must be a JSON export with an 'aliases' array", "error");
        return;
      }
      importMut.mutate({ aliases: data.aliases });
    } catch {
      notify("Failed to parse JSON file", "error");
    }
  };

  const handleSave = (form: ShellAliasInput) => {
    if (editing === "new") {
      create.mutate(form, { onSuccess: () => setEditing(null) });
    } else if (editing) {
      update.mutate({ id: editing.id, ...form }, { onSuccess: () => setEditing(null) });
    }
  };

  const handleDelete = async (alias: ShellAlias) => {
    const ok = await confirm(`Delete alias "${alias.name}"?`);
    if (ok) remove.mutate(alias.id);
  };

  return (
    <div>
      <PageHeading
        title="Aliases"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip content="Import a JSON export from cursedalchemy">
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                onClick={() => fileRef.current?.click()}
                disabled={importMut.isPending}
              >
                <IconClipboard className="mr-1 h-4 w-4" />
                Import JSON
              </button>
            </Tooltip>
            <Tooltip content="Download all aliases as a shell script">
              <a href="/api/shell-aliases/export.sh" className={BTN_GHOST_CLASS} download>
                <IconFileText className="mr-1 h-4 w-4" />
                Download .sh
              </a>
            </Tooltip>
            <Tooltip content="Export as JSON for cursedalchemy">
              <a href="/api/shell-aliases/export.json" className={BTN_GHOST_CLASS} download>
                <IconFileText className="mr-1 h-4 w-4" />
                Export JSON
              </a>
            </Tooltip>
            <Tooltip content="Write aliases to ~/.rubato-user-aliases.sh and optionally source it">
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                onClick={() => setShowSetup(true)}
              >
                <IconPlay className="mr-1 h-4 w-4" />
                Apply to shell
              </button>
            </Tooltip>
            <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => setEditing("new")}>
              <IconPlus className="mr-1 h-4 w-4" />
              New Alias
            </button>
          </div>
        }
      />

      <input
        ref={fileRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onPickFile(e.target.files[0])}
      />

      <div className="relative mb-4">
        <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search aliases…"
          className={`${FIELD_CLASS} pl-9`}
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : visible.length === 0 ? (
        <div className={`${CARD_CLASS} flex flex-col items-center gap-3 p-10 text-center`}>
          <IconTerminal className="h-10 w-10 text-gray-300" />
          <p className="font-medium">{search ? "No matches" : "No aliases yet"}</p>
          <p className="text-sm text-gray-500">
            {search
              ? "Try a different search term."
              : "Add your first alias, then apply it to your shell config or download the .sh file."}
          </p>
          {!search && (
            <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => setEditing("new")}>
              <IconPlus className="mr-1 h-4 w-4" />
              New Alias
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((alias) => (
            <div key={alias.id} className={`${CARD_CLASS} group flex items-start gap-4 p-4`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold text-accent">{alias.name}</span>
                  {parseTags(alias.tags).map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
                <code className="mt-1 block font-mono text-sm text-gray-600 dark:text-gray-400">
                  {alias.command}
                </code>
                {alias.description && (
                  <p className="mt-1 text-sm text-gray-500">{alias.description}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  className={`${BTN_GHOST_CLASS} px-2 py-1`}
                  onClick={() => setEditing(alias)}
                  title="Edit"
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`${BTN_GHOST_CLASS} px-2 py-1 text-red-500 hover:text-red-700`}
                  onClick={() => handleDelete(alias)}
                  title="Delete"
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing !== null && (
        <AliasModal
          initial={editing === "new" ? {} : editing}
          onClose={() => setEditing(null)}
          onSave={handleSave}
          saving={create.isPending || update.isPending}
        />
      )}

      {showSetup && <SetupPanel onClose={() => setShowSetup(false)} />}
    </div>
  );
}
