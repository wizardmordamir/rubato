import { useCopyToClipboard } from "cursedbelt/react";
import type { ReactNode } from "react";
import { Badge, BTN_GHOST_CLASS, CARD_CLASS, Tooltip } from "../../components";
import { useConfirm } from "../../confirm";
import { useToast } from "../../toast";

export const TOOL_TEXTAREA_CLASS =
  "w-full rounded-lg border border-gray-300 bg-white p-3 font-mono text-xs text-gray-900 transition focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

/** A text-label button that copies `text` to the clipboard and toasts. The
 *  clipboard write + failure handling come from cwip's shared `useCopyToClipboard`
 *  so the logic isn't re-rolled here. */
export function CopyButton({ text, label = "Copy", disabled }: { text: string; label?: string; disabled?: boolean }) {
  const { notify } = useToast();
  const { copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      disabled={disabled || !text}
      onClick={async () => {
        if (await copy(text)) notify("Copied", "success");
        else notify("Couldn't copy to clipboard", "error");
      }}
      className={BTN_GHOST_CLASS}
    >
      {label}
    </button>
  );
}

/** A titled, read-only output box with a copy button. */
export function OutputBox({ title, text }: { title: string; text: string }) {
  return (
    <div className={`${CARD_CLASS} p-0`}>
      <div className="flex items-center gap-2 border-gray-200 border-b px-3 py-1.5 dark:border-gray-800">
        <span className="text-xs font-medium text-gray-500">{title}</span>
        <span className="ml-auto">
          <CopyButton text={text} />
        </span>
      </div>
      <pre className="max-h-[24rem] overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
        {text || <span className="text-gray-400">…</span>}
      </pre>
    </div>
  );
}

/** A red error line with an optional line/column suffix. */
export function ErrorNote({ message, line, col }: { message?: string; line?: number; col?: number }) {
  if (!message) return null;
  const where = line ? ` (line ${line}${col ? `, col ${col}` : ""})` : "";
  return (
    <div className="flex items-center gap-2">
      <Badge tone="error">error</Badge>
      <span className="text-xs text-red-600 dark:text-red-300">
        {message}
        {where}
      </span>
    </div>
  );
}

/** A labeled control wrapper used across the tools. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-500">{label}</span>
      {children}
    </label>
  );
}

/** A compact list of saved items with load + delete actions. */
export function SavedList({
  items,
  onLoad,
  onDelete,
}: {
  items: Array<{ id: string; label: string; sub?: string }>;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const confirm = useConfirm();
  if (items.length === 0) return <p className="text-xs text-gray-400">Nothing saved yet.</p>;
  return (
    <ul className="space-y-0.5">
      {items.map((it) => (
        <li key={it.id} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onLoad(it.id)}
            className="flex-1 truncate text-left text-sm hover:text-accent"
          >
            {it.label}
            {it.sub && <span className="ml-1.5 font-mono text-xs text-gray-400">{it.sub}</span>}
          </button>
          <Tooltip content="delete">
            <button
              type="button"
              onClick={async () => {
                if (await confirm({ prompt: "Delete this saved item?", confirmText: "Delete" })) onDelete(it.id);
              }}
              aria-label="delete"
              className="text-xs text-red-500 transition-colors hover:text-red-700"
            >
              ✕
            </button>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}
