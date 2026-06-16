import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import type { DiffFile } from "./api";
import { Badge, Tooltip } from "./components";
import { DiffViewer } from "./DiffViewer";

const STATUS_TONE: Record<DiffFile["status"], "success" | "error" | "neutral" | "accent"> = {
  added: "success",
  deleted: "error",
  modified: "accent",
  renamed: "accent",
  untracked: "neutral",
};
const STATUS_ABBR: Record<DiffFile["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
  untracked: "?",
};

export interface DiffBrowserProps {
  files: DiffFile[];
  /** Fetch one file's unified diff text. */
  fetchFileDiff: (file: DiffFile) => Promise<string>;
  /** React-query key for a file's diff (must vary with base/mode/ref). */
  fileDiffKey: (file: DiffFile) => unknown[];
  /** Fetch the combined diff of every file. */
  fetchFullDiff: () => Promise<string>;
  /** React-query key for the combined diff. */
  fullDiffKey: unknown[];
  /** Controls rendered at the left of the toolbar (e.g. a base/mode selector). */
  toolbar?: ReactNode;
  /** Optional per-file trailing action (e.g. a discard button). */
  fileAction?: (file: DiffFile) => ReactNode;
  /** When set, each file row gets a selection checkbox (e.g. for commit-selected). */
  selectedPaths?: Set<string>;
  onToggleSelect?: (path: string) => void;
  /** Controls rendered next to the toolbar when selecting (e.g. message + commit). */
  selectionToolbar?: ReactNode;
  emptyText?: string;
}

/**
 * Browse a set of changed files: a "By file" mode (file list + Prev/Next, one
 * GitHub-style diff at a time) and an "All" mode (one combined diff of everything).
 * Diff fetching/keys are injected so the same browser drives working-tree diffs,
 * stash diffs, etc. — the caller supplies the toolbar (base/mode) and per-file
 * actions. Built on {@link DiffViewer}.
 */
export function DiffBrowser({
  files,
  fetchFileDiff,
  fileDiffKey,
  fetchFullDiff,
  fullDiffKey,
  toolbar,
  fileAction,
  selectedPaths,
  onToggleSelect,
  selectionToolbar,
  emptyText = "No changes.",
}: DiffBrowserProps) {
  const [view, setView] = useState<"single" | "all">("single");
  const [idx, setIdx] = useState(0);
  const safeIdx = files.length ? Math.min(idx, files.length - 1) : 0;
  // Keep the selection valid as the file set changes (e.g. switching base).
  useEffect(() => {
    if (idx > Math.max(0, files.length - 1)) setIdx(Math.max(0, files.length - 1));
  }, [files.length, idx]);
  const current: DiffFile | undefined = files[safeIdx];

  const fileQ = useQuery({
    queryKey: current ? fileDiffKey(current) : ["diff-none"],
    queryFn: () => fetchFileDiff(current as DiffFile),
    enabled: view === "single" && !!current,
  });
  const allQ = useQuery({ queryKey: fullDiffKey, queryFn: fetchFullDiff, enabled: view === "all" });

  if (files.length === 0) return <p className="text-xs text-gray-400">{emptyText}</p>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        {selectionToolbar}
        <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-gray-300 text-xs dark:border-gray-700">
          {(["single", "all"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={
                view === v
                  ? "bg-accent px-2.5 py-1 text-white"
                  : "px-2.5 py-1 hover:bg-gray-100 dark:hover:bg-gray-800"
              }
              onClick={() => setView(v)}
            >
              {v === "single" ? "By file" : `All (${files.length})`}
            </button>
          ))}
        </div>
      </div>

      {view === "all" ? (
        allQ.isLoading ? (
          <DiffLoading />
        ) : (
          <DiffViewer diff={allQ.data ?? ""} />
        )
      ) : (
        <div className="grid gap-3 md:grid-cols-[minmax(170px,250px)_1fr]">
          <ul className="max-h-[60vh] divide-y divide-gray-100 overflow-auto rounded-lg border border-gray-200 text-xs dark:divide-gray-800 dark:border-gray-800">
            {files.map((f, i) => (
              <li
                key={f.path}
                className={`flex items-center gap-2 px-2 py-1.5 ${i === safeIdx ? "bg-accent/10" : ""}`}
              >
                {onToggleSelect && (
                  <Tooltip content="Select for commit">
                    <input
                      type="checkbox"
                      className="shrink-0"
                      checked={selectedPaths?.has(f.path) ?? false}
                      onChange={() => onToggleSelect(f.path)}
                      aria-label="Select for commit"
                    />
                  </Tooltip>
                )}
                <Tooltip content={f.path}>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setIdx(i)}
                  >
                    <Badge tone={STATUS_TONE[f.status]}>{STATUS_ABBR[f.status]}</Badge>
                    <span className="truncate font-mono">{f.path}</span>
                  </button>
                </Tooltip>
                {fileAction?.(f)}
              </li>
            ))}
          </ul>
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-xs">
              <Tooltip content={current?.path ?? ""}>
                <span className="truncate font-mono text-gray-500">
                  {current?.path}
                </span>
              </Tooltip>
              <span className="ml-auto shrink-0 text-gray-400">
                {safeIdx + 1}/{files.length}
              </span>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
                disabled={safeIdx <= 0}
                onClick={() => setIdx(safeIdx - 1)}
              >
                ‹ Prev
              </button>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
                disabled={safeIdx >= files.length - 1}
                onClick={() => setIdx(safeIdx + 1)}
              >
                Next ›
              </button>
            </div>
            {fileQ.isLoading ? <DiffLoading /> : <DiffViewer diff={fileQ.data ?? ""} />}
          </div>
        </div>
      )}
    </div>
  );
}

function DiffLoading() {
  return <p className="text-xs text-gray-400">loading diff…</p>;
}
