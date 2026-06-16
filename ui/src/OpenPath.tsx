/**
 * "Open in editor" affordances for any filesystem path shown in the UI.
 *
 * Both hit `POST /api/open` (the `gotab`/`openInEditor` mechanism for an arbitrary
 * path) and toast the result, so anywhere we display a path — config.json, .env,
 * ~/.claude/CLAUDE.md, a run's output file, a command's script, an app dir — the
 * user can jump straight to it in their configured editor (code / cursor / …).
 *
 * - `OpenPathButton` — a bare icon button; drop it next to a path you render
 *   yourself (a table cell, a detail field).
 * - `PathRef` — renders the path as a mono `<code>` chip WITH the button after it;
 *   use it in prose/help text in place of a plain `<code>~/.rubato/.env</code>`.
 */

import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { openPath } from "./api";
import { IconCode } from "./icons";
import { useToast } from "./toast";

/**
 * One-click "open this path in the editor". Stops click propagation so it works
 * inside clickable cards/rows without also triggering their onClick.
 */
export function OpenPathButton({
  path,
  title,
  className,
  size = 14,
  children,
}: {
  path: string;
  title?: string;
  className?: string;
  size?: number;
  children?: ReactNode;
}) {
  const { notify } = useToast();
  const open = useMutation({
    mutationFn: () => openPath(path),
    onSuccess: (r) => notify(`Opening ${r.path} in ${r.editor}`, "success"),
    onError: (e) => notify(e instanceof Error ? e.message : "open failed", "error"),
  });
  return (
    <button
      type="button"
      title={title ?? `Open ${path} in editor`}
      aria-label={`Open ${path} in editor`}
      disabled={open.isPending}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        open.mutate();
      }}
      className={
        className ??
        "inline-flex shrink-0 items-center justify-center rounded p-0.5 align-middle text-gray-400 transition-colors hover:text-accent disabled:opacity-50"
      }
    >
      {children ?? <IconCode size={size} />}
    </button>
  );
}

/**
 * A path rendered as a mono `<code>` chip followed by an open-in-editor button.
 * Inline-friendly: use it inside sentences/help text where a path appears.
 *
 * Long paths (no spaces to break on) WRAP onto multiple lines and stay inside
 * their container instead of overflowing — `max-w-full` caps the inline-flex at
 * the available width, `min-w-0 break-all` lets the `<code>` break anywhere, and
 * `items-start` keeps the open-in-editor button aligned to the path's first line.
 */
export function PathRef({
  path,
  className = "",
  codeClassName = "font-mono",
}: {
  path: string;
  className?: string;
  codeClassName?: string;
}) {
  return (
    <span className={`inline-flex max-w-full items-start gap-1 ${className}`}>
      <code className={`min-w-0 break-all ${codeClassName}`}>{path}</code>
      <OpenPathButton path={path} />
    </span>
  );
}
