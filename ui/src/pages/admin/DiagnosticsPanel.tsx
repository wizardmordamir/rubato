import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  type DiagnosticSummary,
  diagnosticDownloadUrl,
  fetchDiagnosticContent,
  fetchDiagnostics,
} from "../../api";
import { CARD_CLASS, OpenPathButton, Tooltip } from "../../components";
import { FileViewer } from "../FileViewer";

type StatusFilter = "all" | "error" | "warn" | "ok";

const STATUS_STYLE: Record<DiagnosticSummary["status"], string> = {
  error: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  warn: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  ok: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
};

function when(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleString();
}

/**
 * Admin view of the diagnostic reports/logs written under <outputDir>/diagnostics.
 * Filter by status/activity, read a report (overview + error + shape diffs) and its
 * companion step log, and download either for sharing from another environment.
 */
export function DiagnosticsPanel() {
  const { data: diagnostics = [] } = useQuery({
    queryKey: ["diagnostics"],
    queryFn: fetchDiagnostics,
    refetchInterval: 5000,
  });
  const [status, setStatus] = useState<StatusFilter>("all");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<DiagnosticSummary | null>(null);
  // "report" shows the JSON overview; "log" shows the JSONL step log.
  const [view, setView] = useState<"report" | "log">("report");

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return diagnostics.filter(
      (d) =>
        (status === "all" || d.status === status) &&
        (!q || d.activity.toLowerCase().includes(q) || (d.intent ?? "").toLowerCase().includes(q)),
    );
  }, [diagnostics, status, filter]);

  const path = selected ? (view === "log" ? selected.logPath : selected.path) : undefined;
  const { data: viewing, isLoading } = useQuery({
    queryKey: ["diagnostic", path],
    queryFn: () => fetchDiagnosticContent(path as string),
    enabled: !!path,
  });

  const counts = useMemo(
    () => ({
      error: diagnostics.filter((d) => d.status === "error").length,
      warn: diagnostics.filter((d) => d.status === "warn").length,
      ok: diagnostics.filter((d) => d.status === "ok").length,
    }),
    [diagnostics],
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        Diagnostic reports + step logs written under <code>&lt;outputDir&gt;/diagnostics</code>
        <OpenPathButton path="diagnostics" /> — what ran, what it was
        trying to do, errors (classified, with stack), and JSON shape diffs. Secrets are redacted. Read-only; export to
        share.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {(["all", "error", "warn", "ok"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              status === s
                ? "bg-accent text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300"
            }`}
          >
            {s}
            {s !== "all" && counts[s] ? ` (${counts[s]})` : ""}
          </button>
        ))}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by activity…"
          className="ml-auto w-48 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
        />
      </div>

      {diagnostics.length === 0 ? (
        <p className="text-gray-400">No diagnostics yet — they appear when a run, pipeline, ask, or report script finishes.</p>
      ) : (
        <div className="flex gap-4">
          <ul className="flex max-h-[28rem] w-72 shrink-0 flex-col gap-1 overflow-auto">
            {shown.map((d) => (
              <li key={d.path}>
                <Tooltip content={d.intent ?? d.activity}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(d);
                    setView("report");
                  }}
                  className={`w-full rounded-lg px-3 py-1.5 text-left transition-colors ${
                    d.path === selected?.path
                      ? "bg-accent-soft"
                      : "hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[d.status]}`}>
                      {d.status}
                    </span>
                    <span className="truncate font-mono text-xs">{d.activity}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-gray-400">
                    {d.errorClass ? `${d.errorClass} · ` : ""}
                    {when(d.modifiedAt)}
                  </div>
                </button>
                </Tooltip>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-1.5 text-xs text-gray-400">no match</li>}
          </ul>

          <section className="min-w-0 flex-1">
            {!selected ? (
              <p className="text-gray-400">Select a diagnostic to view it.</p>
            ) : (
              <div className={`${CARD_CLASS} p-4`}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLE[selected.status]}`}>
                    {selected.status}
                  </span>
                  <span className="font-mono text-sm font-medium">{selected.activity}</span>
                  <div className="ml-auto flex items-center gap-1 text-xs">
                    <button
                      type="button"
                      onClick={() => setView("report")}
                      className={`rounded px-2 py-0.5 ${view === "report" ? "bg-accent text-white" : "text-accent hover:underline"}`}
                    >
                      Report
                    </button>
                    {selected.logPath && (
                      <button
                        type="button"
                        onClick={() => setView("log")}
                        className={`rounded px-2 py-0.5 ${view === "log" ? "bg-accent text-white" : "text-accent hover:underline"}`}
                      >
                        Log
                      </button>
                    )}
                    <a href={diagnosticDownloadUrl(selected.path)} download className="text-accent hover:underline">
                      ↓ Report
                    </a>
                    {selected.logPath && (
                      <a href={diagnosticDownloadUrl(selected.logPath)} download className="text-accent hover:underline">
                        ↓ Log
                      </a>
                    )}
                    {selected.path && <OpenPathButton path={selected.path} />}
                  </div>
                </div>
                {selected.intent && <p className="mb-2 text-xs text-gray-500">{selected.intent}</p>}
                {isLoading ? (
                  <p className="text-gray-400">loading…</p>
                ) : (
                  <FileViewer name={path ?? selected.path} content={viewing?.content ?? ""} />
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
