import { type DiffFileChange, type DiffLine, parseUnifiedDiff } from "@shared/diff";
import { Fragment } from "react";
import { Tooltip } from "./components";

/**
 * GitHub-style unified-diff viewer. Renders raw `git diff` text as one block per
 * file: a header (path · ±counts), then rows with old/new line-number gutters,
 * green additions / red deletions / plain context, and blue hunk headers. Each
 * file scrolls horizontally for long lines; the whole block caps its height and
 * scrolls vertically. Empty input shows a muted "No changes." note. Light + dark.
 */
export function DiffViewer({ diff, className = "" }: { diff: string; className?: string }) {
  const files = parseUnifiedDiff(diff);
  if (files.length === 0) return <p className="text-xs text-gray-400">No changes.</p>;
  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {files.map((file, i) => (
        <DiffFileBlock key={`${file.path}-${i}`} file={file} />
      ))}
    </div>
  );
}

function DiffFileBlock({ file }: { file: DiffFileChange }) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs dark:border-gray-800 dark:bg-gray-800/60">
        <Tooltip content={file.path}>
          <span className="truncate font-mono font-medium text-gray-700 dark:text-gray-200">
            {file.path || "(file)"}
          </span>
        </Tooltip>
        {file.kind !== "modified" && (
          <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-700 dark:text-gray-300">
            {file.kind}
          </span>
        )}
        <span className="ml-auto flex shrink-0 gap-2 font-mono tabular-nums">
          {file.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-rose-600 dark:text-rose-400">−{file.deletions}</span>}
        </span>
      </div>

      {file.binary ? (
        <p className="px-3 py-2 text-xs text-gray-400">Binary file — not shown.</p>
      ) : file.hunks.length === 0 ? (
        <p className="px-3 py-2 text-xs text-gray-400">No textual changes.</p>
      ) : (
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full border-collapse font-mono text-xs leading-relaxed">
            <tbody>
              {file.hunks.map((hunk, hi) => (
                <Fragment key={hi}>
                  <tr className="select-none bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                    <td className="bg-sky-100/60 dark:bg-sky-900/30" />
                    <td className="bg-sky-100/60 dark:bg-sky-900/30" />
                    <td className="whitespace-pre px-2 py-0.5">{hunk.header}</td>
                  </tr>
                  {hunk.lines.map((line, li) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static, non-reordering diff rows
                    <DiffRow key={li} line={line} />
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Per-line-type styling: row tint, gutter tint, and the leading sign char. */
const ROW_STYLES: Record<DiffLine["type"], { row: string; gutter: string; sign: string }> = {
  add: {
    row: "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200",
    gutter: "bg-emerald-100/60 text-emerald-700/70 dark:bg-emerald-900/30 dark:text-emerald-300/60",
    sign: "+",
  },
  del: {
    row: "bg-rose-50 text-rose-900 dark:bg-rose-950/30 dark:text-rose-200",
    gutter: "bg-rose-100/60 text-rose-700/70 dark:bg-rose-900/30 dark:text-rose-300/60",
    sign: "-",
  },
  context: {
    row: "text-gray-700 dark:text-gray-300",
    gutter: "bg-gray-50 text-gray-400 dark:bg-gray-900/40 dark:text-gray-600",
    sign: " ",
  },
};

const GUTTER_CLASS = "w-[1%] select-none whitespace-nowrap px-2 text-right align-top tabular-nums";

function DiffRow({ line }: { line: DiffLine }) {
  const s = ROW_STYLES[line.type];
  return (
    <tr className={s.row}>
      <td className={`${GUTTER_CLASS} ${s.gutter}`}>{line.oldNo ?? ""}</td>
      <td className={`${GUTTER_CLASS} ${s.gutter}`}>{line.newNo ?? ""}</td>
      <td className="whitespace-pre px-2 align-top">
        <span className="select-none pr-2 opacity-50">{s.sign}</span>
        {line.text || " "}
      </td>
    </tr>
  );
}
