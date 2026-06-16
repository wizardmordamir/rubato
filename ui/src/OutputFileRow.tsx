/**
 * One saved output-file path on a run — a `<command>.txt` capture, a diagnostic
 * report, or a structured data report (`.report.json` / `.report.csv`). Toggle it
 * to view the full file inline (pretty JSON / a CSV table / rendered markdown via
 * the shared FileViewer), copy the path, or open it in the editor.
 *
 * Shared by the Runs page (every run's saved files) and the Commands page's
 * report links (a run's data report), so a report is viewable from either place
 * through the same row — one source of truth for "view/open a run's file".
 */
import { useQuery } from "@tanstack/react-query";
import { useCopyToClipboard } from "cwip/react";
import { useState } from "react";
import { fetchFileContent, fileDownloadUrl } from "./api";
import { OpenPathButton, Tooltip } from "./components";
import { FileViewer } from "./pages/FileViewer";
import { useToast } from "./toast";

export function OutputFileRow({ path, onCopy }: { path: string; onCopy?: (text: string) => void }) {
  const { notify } = useToast();
  const { copy: copyToClipboard } = useCopyToClipboard();
  const [open, setOpen] = useState(false);
  const name = path.split("/").pop() ?? path;
  const { data, isLoading, error } = useQuery({
    queryKey: ["file", path],
    queryFn: () => fetchFileContent(path),
    enabled: open,
  });

  // Default to clipboard (via cwip's shared hook) + toast; callers can pass their
  // own copy handler.
  const copy =
    onCopy ??
    ((text: string) => {
      void copyToClipboard(text).then((ok) =>
        notify(ok ? "Path copied" : "Couldn't copy", ok ? "success" : "error"),
      );
    });

  return (
    <div className="mt-1.5 text-xs text-gray-500">
      <div className="flex items-center gap-2">
        <Tooltip content={open ? "Hide file" : "View full file"}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Hide file" : "View full file"}
          className="truncate text-left font-mono hover:text-accent"
        >
          {open ? "▾ " : "▸ "}
          {path}
        </button>
        </Tooltip>
        <button
          type="button"
          onClick={() => copy(path)}
          className="shrink-0 rounded-md border border-gray-300 px-1.5 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          copy
        </button>
        <Tooltip content={`Download ${name} (opens .csv/.xlsx in Excel)`}>
        <a
          href={fileDownloadUrl(path)}
          download
          aria-label={`Download ${name} (opens .csv/.xlsx in Excel)`}
          className="shrink-0 rounded-md border border-gray-300 px-1.5 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          ↓
        </a>
        </Tooltip>
        <OpenPathButton path={path} />
      </div>
      {open && (
        <div className="mt-1.5">
          {isLoading ? (
            <p className="text-gray-400">loading…</p>
          ) : error ? (
            <p className="text-rose-500">{error instanceof Error ? error.message : "couldn't read file"}</p>
          ) : (
            <FileViewer name={name} content={data?.content ?? ""} />
          )}
        </div>
      )}
    </div>
  );
}
