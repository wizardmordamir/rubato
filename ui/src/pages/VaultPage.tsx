import { ApiError } from "cwip";
import { CopyButton as CwipCopyButton } from "cursedbelt/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import {
  changeVaultMaster,
  createVaultItem,
  deleteVaultItem,
  fetchVaultItems,
  fetchVaultStatus,
  setVaultMaster,
  unlockVault,
  updateVaultItem,
  type VaultField,
  type VaultItem,
  type VaultItemInput,
} from "../api";
import { Alert, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, InfoHint, PageHeading, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { IconEye, IconEyeOff, IconPlus, IconShield, IconTrash } from "../icons";
import { Modal } from "../Modal";
import { useToast } from "../toast";

/**
 * Vault — an encrypted store for logins and secrets (the single-user sibling of
 * cursedalchemy's `/vault`). Items are encrypted at rest under a server-held key;
 * revealing or editing them needs the vault master password, which is exchanged
 * for a short-lived unlock token kept ONLY in memory (a refresh re-locks). There
 * is no email reset — rubato is single-user and loopback-only.
 */

const ITEMS_KEY = ["vault", "items"];
const STATUS_KEY = ["vault", "status"];

const errMsg = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.extractMessage() : e instanceof Error ? e.message : fallback;

export function VaultPage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();

  const { data: status } = useQuery({ queryKey: STATUS_KEY, queryFn: fetchVaultStatus });

  // The unlock token lives ONLY in memory (never localStorage); navigating away
  // or refreshing clears it, so the vault re-locks.
  const [token, setToken] = useState<string | null>(null);
  const locked = !token;

  const { data: items = [], isLoading } = useQuery({
    queryKey: ITEMS_KEY,
    enabled: !!token,
    queryFn: () => fetchVaultItems(token as string),
  });

  const [editing, setEditing] = useState<VaultItem | "new" | null>(null);
  const [showChangeMaster, setShowChangeMaster] = useState(false);

  const refreshItems = () => qc.invalidateQueries({ queryKey: ITEMS_KEY });
  const refreshStatus = () => qc.invalidateQueries({ queryKey: STATUS_KEY });
  const onError = (e: unknown) => notify(errMsg(e, "Request failed"), "error");

  const create = useMutation({
    mutationFn: ({ input }: { input: VaultItemInput }) => createVaultItem(token as string, input),
    onSuccess: () => {
      refreshItems();
      refreshStatus();
    },
    onError,
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: VaultItemInput }) => updateVaultItem(token as string, id, input),
    onSuccess: refreshItems,
    onError,
  });
  const remove = useMutation({
    mutationFn: deleteVaultItem,
    onSuccess: () => {
      refreshItems();
      refreshStatus();
    },
    onError,
  });

  const lock = () => {
    setToken(null);
    qc.removeQueries({ queryKey: ITEMS_KEY }); // drop decrypted items from the cache on lock
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeading
        title="Vault"
        count={locked ? undefined : items.length}
        actions={
          locked ? undefined : (
            <>
              <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => setEditing("new")}>
                <IconPlus /> Add item
              </button>
              <Tooltip
                multiline
                content="Change your vault password. Requires your current one; your saved items stay intact because they're encrypted under a server-held key, not this password."
              >
                <button type="button" className={BTN_GHOST_CLASS} onClick={() => setShowChangeMaster(true)}>
                  Change password
                </button>
              </Tooltip>
              <Tooltip
                multiline
                content="Discards the in-memory unlock token and re-locks the vault. Items can no longer be revealed or edited until you unlock again."
              >
                <button type="button" className={BTN_GHOST_CLASS} onClick={lock}>
                  Lock
                </button>
              </Tooltip>
            </>
          )
        }
      />

      {locked ? (
        <LockedPanel hasMaster={status?.hasMaster ?? false} onUnlocked={setToken} />
      ) : isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : items.length === 0 ? (
        <div className={`${CARD_CLASS} flex flex-col items-center gap-3 p-10 text-center`}>
          <IconShield className="text-3xl text-gray-400" />
          <div>
            <p className="font-medium">Your vault is empty</p>
            <p className="text-sm text-gray-500">Add a login or secret — it's encrypted before it's stored.</p>
          </div>
          <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => setEditing("new")}>
            <IconPlus /> Add your first item
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <VaultItemCard
              key={item.id}
              item={item}
              onEdit={() => setEditing(item)}
              onDelete={async () => {
                if (await confirm({ prompt: `Delete "${item.title}"?`, confirmText: "Delete" })) remove.mutate(item.id);
              }}
            />
          ))}
        </div>
      )}

      {editing && token && (
        <ItemEditor
          item={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(input, id) => {
            if (id) update.mutate({ id, input });
            else create.mutate({ input });
            setEditing(null);
          }}
        />
      )}

      {showChangeMaster && <ChangeMasterModal onClose={() => setShowChangeMaster(false)} onChanged={setToken} />}
    </div>
  );
}

// ── Locked: set master (first time) / unlock ──────────────────────────────────

function LockedPanel({ hasMaster, onUnlocked }: { hasMaster: boolean; onUnlocked: (token: string) => void }) {
  const { notify } = useToast();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");

  const unlock = useMutation({ mutationFn: unlockVault });
  const setMaster = useMutation({ mutationFn: setVaultMaster });

  const mode = hasMaster ? "unlock" : "set";

  const submit = async () => {
    setErr("");
    try {
      if (mode === "unlock") {
        const { token } = await unlock.mutateAsync(pw);
        onUnlocked(token);
        return;
      }
      if (pw.length < 8) return setErr("Use at least 8 characters.");
      if (pw !== pw2) return setErr("Passwords do not match.");
      const { token } = await setMaster.mutateAsync(pw);
      notify("Vault password set.", "success");
      onUnlocked(token);
    } catch (e) {
      setErr(errMsg(e, mode === "unlock" ? "Incorrect vault password." : "Could not save. Try again."));
    }
  };

  return (
    <div className={`${CARD_CLASS} mx-auto flex w-full max-w-md flex-col gap-3 p-6`}>
      <div className="flex items-center gap-2">
        <IconShield className="text-xl text-accent" />
        <h2 className="text-lg font-semibold">{mode === "set" ? "Set a vault password" : "Vault locked"}</h2>
        <InfoHint title="Vault password">
          <p>
            A <strong>separate gate</strong> from anything else — it unlocks viewing and editing your items.
          </p>
          <p className="mt-1.5">
            Unlocking grants a short-lived (15-min) token kept <strong>only in memory</strong>, so a page refresh
            re-locks the vault.
          </p>
          <p className="mt-1.5">
            Items are encrypted at rest under a <strong>server-held key</strong> stored outside the database — a
            DB-only leak yields only ciphertext.
          </p>
        </InfoHint>
      </div>
      <p className="text-sm text-gray-500">
        {mode === "unlock"
          ? "Enter your vault password to reveal your items."
          : "This password protects your stored secrets. You'll need it to view or edit them."}
      </p>
      {err && (
        <Alert tone="error" size="sm">
          {err}
        </Alert>
      )}
      <input
        type="password"
        className={FIELD_CLASS}
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="vault password"
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {mode !== "unlock" && (
        <input
          type="password"
          className={FIELD_CLASS}
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          placeholder="confirm password"
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      )}
      <button
        type="button"
        className={BTN_PRIMARY_CLASS}
        onClick={submit}
        disabled={unlock.isPending || setMaster.isPending}
      >
        {mode === "unlock" ? "Unlock" : "Set password"}
      </button>
      {mode === "set" && (
        <p className="text-xs text-gray-400">
          Heads up: there is no email reset (this is a single-user app). Keep this password safe — without it, your
          items can't be revealed.
        </p>
      )}
    </div>
  );
}

// ── Item card (unlocked) ──────────────────────────────────────────────────────

function VaultItemCard({ item, onEdit, onDelete }: { item: VaultItem; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className={`${CARD_CLASS} flex flex-col gap-2 p-4`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{item.title}</h3>
            {item.link && (
              <a
                href={item.link}
                target="_blank"
                rel="noreferrer"
                className="truncate text-xs text-accent hover:underline"
              >
                {item.link}
              </a>
            )}
          </div>
          {item.description && <p className="mt-0.5 text-xs text-gray-500">{item.description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className={`${BTN_GHOST_CLASS} px-2 py-1`} onClick={onEdit}>
            Edit
          </button>
          <Tooltip content="Delete item">
            <button
              type="button"
              aria-label="Delete item"
              className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30"
              onClick={onDelete}
            >
              <IconTrash />
            </button>
          </Tooltip>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-sm">
        {item.username && (
          <>
            <dt className="text-xs text-gray-400">User</dt>
            <dd className="flex items-center gap-1">
              <span className="font-mono text-xs">{item.username}</span>
              <CopyButton value={item.username} />
            </dd>
          </>
        )}
        {item.password && (
          <>
            <dt className="text-xs text-gray-400">Password</dt>
            <dd>
              <SecretValue value={item.password} label={`${item.title} password`} />
            </dd>
          </>
        )}
        {item.fields.map((f) => (
          <FieldRow key={f.label} field={f} itemTitle={item.title} />
        ))}
      </dl>
      {item.notes && <p className="whitespace-pre-wrap text-xs text-gray-500">{item.notes}</p>}
    </div>
  );
}

function FieldRow({ field, itemTitle }: { field: VaultField; itemTitle: string }) {
  return (
    <>
      <dt className="text-xs text-gray-400">{field.label}</dt>
      <dd className="flex items-center gap-1">
        {field.secret ? (
          <SecretValue value={field.value} label={`${itemTitle} ${field.label}`} />
        ) : (
          <>
            <span className="font-mono text-xs">{field.value}</span>
            <CopyButton value={field.value} />
          </>
        )}
      </dd>
    </>
  );
}

// A read-only secret value: dots until revealed, with reveal + copy toggles. The
// plaintext is held in a read-only input, so copy never has to reveal it on screen.
function SecretValue({ value, label }: { value: string; label: string }) {
  const { notify } = useToast();
  const [shown, setShown] = useState(false);
  if (!value) return <span className="text-xs text-gray-400">—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <input
        readOnly
        type={shown ? "text" : "password"}
        value={value}
        aria-label={label}
        className="w-40 rounded border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-xs dark:border-gray-700 dark:bg-gray-900"
      />
      <button
        type="button"
        aria-label={shown ? `Hide ${label}` : `Reveal ${label}`}
        className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
        onClick={() => setShown((s) => !s)}
      >
        {shown ? <IconEyeOff /> : <IconEye />}
      </button>
      <CwipCopyButton
        text={value}
        label={`Copy ${label}`}
        tooltip={`Copy ${label}`}
        className="p-1"
        onCopied={() => notify("Copied", "success")}
      />
    </span>
  );
}

// Thin adapter: keeps Vault's `{ value }` call sites + the empty guard while the
// clipboard logic + ✓ confirmation come from cwip's shared CopyButton.
function CopyButton({ value }: { value: string }) {
  const { notify } = useToast();
  if (!value) return null;
  return (
    <CwipCopyButton text={value} tooltip="Copy" className="p-0.5" onCopied={() => notify("Copied", "success")} />
  );
}

// ── Add/edit item modal ───────────────────────────────────────────────────────

function ItemEditor({
  item,
  onClose,
  onSave,
}: {
  item: VaultItem | null;
  onClose: () => void;
  onSave: (input: VaultItemInput, id?: string) => void;
}) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [link, setLink] = useState(item?.link ?? "");
  const [username, setUsername] = useState(item?.username ?? "");
  const [password, setPassword] = useState(item?.password ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [fields, setFields] = useState<VaultField[]>(item?.fields ?? []);
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState("");

  const submit = () => {
    if (!title.trim()) return setErr("A title is required.");
    onSave(
      {
        title: title.trim(),
        link: link.trim() || undefined,
        username: username.trim() || undefined,
        password: password || undefined,
        description: description.trim() || undefined,
        notes: notes.trim() || undefined,
        fields: fields.filter((f) => f.label.trim()),
      },
      item?.id,
    );
  };

  return (
    <Modal title={item ? "Edit item" : "Add item"} onClose={onClose} widthClass="max-w-xl">
      <div className="flex flex-col gap-3">
        {err && (
          <Alert tone="error" size="sm">
            {err}
          </Alert>
        )}
        <Field label="Title">
          <input className={FIELD_CLASS} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Chase Bank" />
        </Field>
        <Field label="Link">
          <input className={FIELD_CLASS} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" />
        </Field>
        <Field label="Username">
          <input
            className={FIELD_CLASS}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username / email"
          />
        </Field>
        <Field label="Password">
          <div className="flex items-center gap-1">
            <input
              type={showPw ? "text" : "password"}
              className={FIELD_CLASS}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
            />
            <button
              type="button"
              aria-label={showPw ? "Hide password" : "Show password"}
              className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              onClick={() => setShowPw((s) => !s)}
            >
              {showPw ? <IconEyeOff /> : <IconEye />}
            </button>
          </div>
        </Field>
        <Field label="Description">
          <input
            className={FIELD_CLASS}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="short description"
          />
        </Field>

        {/* Extra labelled fields (mark any as secret to hide + protect it). */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-gray-500">Custom fields</span>
          {fields.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; labels can be blank/duplicate while editing.
            <div key={i} className="flex items-center gap-2">
              <input
                className={FIELD_CLASS}
                value={f.label}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                placeholder="label"
              />
              <input
                className={FIELD_CLASS}
                value={f.value}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                placeholder="value"
              />
              <label className="flex shrink-0 items-center gap-1 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={!!f.secret}
                  onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, secret: e.target.checked } : x)))}
                />
                secret
              </label>
              <button
                type="button"
                aria-label="Remove field"
                className="p-1 text-gray-400 hover:text-red-600"
                onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className={`${BTN_GHOST_CLASS} self-start`}
            onClick={() => setFields((fs) => [...fs, { label: "", value: "", secret: false }])}
          >
            <IconPlus /> Field
          </button>
        </div>

        <Field label="Notes">
          <textarea className={FIELD_CLASS} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY_CLASS} onClick={submit}>
            {item ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Change-master modal ───────────────────────────────────────────────────────

function ChangeMasterModal({ onClose, onChanged }: { onClose: () => void; onChanged: (token: string) => void }) {
  const { notify } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState("");
  const change = useMutation({ mutationFn: ({ c, n }: { c: string; n: string }) => changeVaultMaster(c, n) });

  const submit = async () => {
    setErr("");
    if (next.length < 8) return setErr("New password must be at least 8 characters.");
    try {
      const { token } = await change.mutateAsync({ c: current, n: next });
      notify("Vault password changed.", "success");
      onChanged(token);
      onClose();
    } catch (e) {
      setErr(errMsg(e, "Could not change the password. Check your current one."));
    }
  };

  return (
    <Modal title="Change vault password" onClose={onClose} widthClass="max-w-sm">
      <div className="flex flex-col gap-3">
        {err && (
          <Alert tone="error" size="sm">
            {err}
          </Alert>
        )}
        <input
          type="password"
          className={FIELD_CLASS}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="current password"
        />
        <input
          type="password"
          className={FIELD_CLASS}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="new password"
        />
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY_CLASS} onClick={submit} disabled={change.isPending}>
            Change
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
