import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchSystemHealth,
  fetchSystemHealthFile,
  type SystemHealthPath,
  type SystemHealthResult,
  type SystemHealthStatus,
} from "../../api";
import { BTN_GHOST_CLASS, CARD_CLASS, OpenPathButton, Tooltip } from "../../components";
import { FileViewer } from "../FileViewer";

// Worst-first so the things needing action sit at the top.
const STATUS_ORDER: Record<SystemHealthStatus, number> = { error: 0, warn: 1, info: 2, ok: 3 };
const STATUS_LABEL: Record<SystemHealthStatus, string> = {
  error: "action needed",
  warn: "warning",
  info: "info",
  ok: "ok",
};
// rubato's Badge only has neutral/accent/success/error tones, so map status →
// className directly (matches cursedalchemy's System Health palette).
const STATUS_TONE: Record<SystemHealthStatus, string> = {
  error: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
};

const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "—");

/**
 * One file/dir a check refers to, made actionable: open it in the editor, and —
 * for a file that exists — toggle an inline view of its contents (lazy-fetched,
 * rendered by the shared FileViewer so JSON/Markdown/CSV/text all read well).
 */
function HealthPathRow({ p }: { p: SystemHealthPath }) {
  const [open, setOpen] = useState(false);
  const canView = p.kind === "file" && p.exists;
  const { data, isLoading, error } = useQuery({
    queryKey: ["system-health-file", p.path],
    queryFn: () => fetchSystemHealthFile(p.path),
    enabled: open && canView,
  });

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700/70">
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1">
        <span className="font-medium text-xs text-gray-600 dark:text-gray-300">{p.label}</span>
        <Tooltip content={p.path}>
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-500">
            {p.path}
          </code>
        </Tooltip>
        {!p.exists && (
          <Tooltip content="This path doesn't exist yet">
            <span className="text-[10px] uppercase tracking-wide text-gray-400">
              not created
            </span>
          </Tooltip>
        )}
        {canView && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="rounded px-1.5 py-0.5 text-[11px] text-accent hover:underline"
          >
            {open ? "Hide" : "View"}
          </button>
        )}
        <OpenPathButton path={p.path} title={`Open ${p.path} in editor`} />
      </div>
      {open && canView && (
        <div className="border-t border-gray-200 px-2 py-2 dark:border-gray-700/70">
          {isLoading ? (
            <p className="text-xs text-gray-400">loading…</p>
          ) : error ? (
            <p className="text-xs text-red-500">{error instanceof Error ? error.message : "failed to read file"}</p>
          ) : (
            <FileViewer name={data?.name ?? p.label} content={data?.content ?? ""} />
          )}
        </div>
      )}
    </div>
  );
}

function HealthCard({ result }: { result: SystemHealthResult }) {
  return (
    <div className={`${CARD_CLASS} flex flex-col gap-2 p-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-medium text-gray-900 dark:text-gray-100">{result.title}</span>
          <span className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500">{result.category}</span>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${STATUS_TONE[result.status]}`}
        >
          {STATUS_LABEL[result.status]}
        </span>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-300">{result.detail}</p>
      {result.remediation.length > 0 && (
        <ol className="ml-4 list-decimal space-y-1 text-sm text-gray-700 dark:text-gray-300">
          {result.remediation.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {result.paths && result.paths.length > 0 && (
        <div className="flex flex-col gap-1">
          {result.paths.map((p) => (
            <HealthPathRow key={p.path} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SystemHealthPanel() {
  const { data, isFetching, refetch } = useQuery({ queryKey: ["system-health"], queryFn: fetchSystemHealth });

  const results = (data?.results ?? []).slice().sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const summary = data?.summary;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="text-xs text-gray-500">
          Live, read-only checks of this rubato instance — each shows what was found and how to fix it.
        </p>
        <Tooltip
          multiline
          content="Runs every health check again right now and refreshes the results below. The checks are read-only — they only inspect this instance (config, disk, dependencies), they don't change anything."
        >
          <button type="button" className={`${BTN_GHOST_CLASS} ml-auto px-3 py-1 text-xs`} onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? "Checking…" : "Re-run checks"}
          </button>
        </Tooltip>
      </div>

      {summary && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          {(["error", "warn", "info", "ok"] as const).map((k) => (
            <span key={k} className={`rounded-full px-3 py-1 font-semibold ${STATUS_TONE[k]}`}>
              {summary[k]} {STATUS_LABEL[k]}
            </span>
          ))}
          <span className="ml-auto self-center text-xs text-gray-400">Checked {fmtTime(data?.checkedAt)}</span>
        </div>
      )}

      {!data ? (
        <p className="text-gray-400">Loading…</p>
      ) : results.length === 0 ? (
        <p className="text-gray-400">No checks reported.</p>
      ) : (
        <ul className="space-y-2">
          {results.map((r) => (
            <li key={r.id}>
              <HealthCard result={r} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
