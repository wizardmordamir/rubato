import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StatTile } from "cursedbelt/react";
import { useMemo, useState } from "react";
import {
  fetchTaskqFindings,
  setTaskqFindingStatus,
  type TaskqFinding,
  type TaskqFindingsResult,
  type TaskqFindingStatus,
} from "../api";
import { Alert, Badge, BTN_GHOST_CLASS, CARD_CLASS, PageHeading, Tabs } from "../components";
import { useToast } from "../toast";

/**
 * Continuous-improvement findings ledger — the owner's review of recurring-detector
 * progress. Recurring auditors (drift / cve / log-review / orchestration-hygiene)
 * record issues into the cwip/taskq `findings` table, idempotent by a stable
 * fingerprint so a fixed/accepted choice is never re-flagged. This panel surfaces the
 * open findings + severity + status + the link to each finding's fix task, and lets
 * the owner triage one (accept = the flagged choice is optimal, won't-fix = a
 * conscious defer, reopen = a regression resurfaced). All data + math is the server's
 * (`/api/taskq/findings`); this is just the presentation.
 */

const QK = ["taskq", "findings"] as const;

/** Status filter buckets (the "open" pill = open + in_progress — the actionable set). */
type StatusFilter = "all" | "open" | "fixed" | "accepted" | "wontfix";
const STATUS_FILTERS: readonly { key: StatusFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "fixed", label: "Fixed" },
  { key: "accepted", label: "Accepted" },
  { key: "wontfix", label: "Won't-fix" },
  { key: "all", label: "All" },
];

const SEVERITY_TONE: Record<string, "neutral" | "accent" | "success" | "warn" | "error"> = {
  critical: "error",
  high: "error",
  medium: "warn",
  low: "neutral",
  info: "neutral",
};
const STATUS_TONE: Record<string, "neutral" | "accent" | "success" | "warn" | "error"> = {
  open: "warn",
  in_progress: "accent",
  fixed: "success",
  accepted: "neutral",
  wontfix: "neutral",
};
/** Severity sort weight (high → low) so the worst findings float to the top. */
const SEVERITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

function matchesFilter(f: TaskqFinding, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "open") return f.status === "open" || f.status === "in_progress";
  return f.status === filter;
}

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export function FindingsLedgerPage({ embedded }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const [filter, setFilter] = useState<StatusFilter>("open");

  // One query over the whole ledger: the summary is global, and client-side filtering
  // keeps the pills instant without re-fetching per selection.
  const { data, isLoading, isError, error } = useQuery({
    queryKey: QK,
    queryFn: () => fetchTaskqFindings(),
  });

  const triage = useMutation({
    mutationFn: ({ id, status }: { id: number; status: TaskqFindingStatus }) => setTaskqFindingStatus(id, status),
    onSuccess: (r: TaskqFindingsResult) => {
      qc.setQueryData(QK, r);
      notify("Finding updated.", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "Update failed", "error"),
  });

  const summary = data?.summary;
  const rows = useMemo(() => {
    const all = data?.findings ?? [];
    return all
      .filter((f) => matchesFilter(f, filter))
      .sort(
        (a, b) =>
          (SEVERITY_WEIGHT[b.severity] ?? 0) - (SEVERITY_WEIGHT[a.severity] ?? 0) || b.id - a.id,
      );
  }, [data?.findings, filter]);

  return (
    <div>
      <PageHeading
        title={embedded ? "Findings ledger" : "Continuous-improvement findings"}
        count={summary?.total}
        actions={
          <button
            type="button"
            className={BTN_GHOST_CLASS}
            onClick={() => qc.invalidateQueries({ queryKey: QK })}
            disabled={isLoading}
          >
            Refresh
          </button>
        }
      />

      {isError && (
        <Alert tone="error" className="mb-4">
          {error instanceof Error ? error.message : "Failed to load findings."}
        </Alert>
      )}

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <div className={`${CARD_CLASS} p-4`}>
            <StatTile label="Open" value={summary.open.toLocaleString()} sub="open + in progress" />
          </div>
          <div className={`${CARD_CLASS} p-4`}>
            <StatTile label="Fixed" value={(summary.byStatus.fixed ?? 0).toLocaleString()} />
          </div>
          <div className={`${CARD_CLASS} p-4`}>
            <StatTile
              label="Accepted / Won't-fix"
              value={((summary.byStatus.accepted ?? 0) + (summary.byStatus.wontfix ?? 0)).toLocaleString()}
              sub="deliberate — never re-flagged"
            />
          </div>
          <div className={`${CARD_CLASS} p-4`}>
            <StatTile
              label="Critical / High open"
              value={(
                (summary.bySeverity.critical ?? 0) + (summary.bySeverity.high ?? 0)
              ).toLocaleString()}
            />
          </div>
          <div className={`${CARD_CLASS} p-4`}>
            <StatTile label="Total" value={summary.total.toLocaleString()} sub="all findings ever" />
          </div>
        </div>
      )}

      <Tabs<StatusFilter> tabs={STATUS_FILTERS} active={filter} onChange={setFilter} />

      {isLoading ? (
        <p className="py-8 text-center text-sm text-gray-400">Loading findings…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400">
          {filter === "open" ? "No open findings — the ledger is clean. 🎉" : "No findings match this filter."}
        </p>
      ) : (
        <div className={`${CARD_CLASS} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-400 dark:border-gray-800">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Severity</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Location</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">Fix task</th>
                <th className="px-3 py-2 font-medium">Found</th>
                <th className="px-3 py-2 font-medium text-right">Triage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const isOpen = f.status === "open" || f.status === "in_progress";
                return (
                  <tr
                    key={f.id}
                    className="border-b border-gray-100 align-top last:border-0 dark:border-gray-800/60"
                  >
                    <td className="px-3 py-2 text-gray-400">{f.id}</td>
                    <td className="px-3 py-2">
                      <Badge tone={SEVERITY_TONE[f.severity] ?? "neutral"}>{f.severity}</Badge>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{f.type}</td>
                    <td className="px-3 py-2">
                      <Badge tone={STATUS_TONE[f.status] ?? "neutral"}>{f.status.replace("_", " ")}</Badge>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{f.location}</td>
                    <td className="px-3 py-2 max-w-md">
                      <span title={f.description}>{f.description}</span>
                      {f.note && <span className="mt-0.5 block text-xs italic text-gray-400">{f.note}</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {f.fix_task ? (
                        <a className="text-accent hover:underline" href={`/taskq?task=${f.fix_task}`}>
                          #{f.fix_task}
                        </a>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-400">{shortDate(f.created_at)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        {isOpen ? (
                          <>
                            <button
                              type="button"
                              className={BTN_GHOST_CLASS}
                              disabled={triage.isPending}
                              onClick={() => triage.mutate({ id: f.id, status: "accepted" })}
                              title="The flagged choice is actually optimal — never re-flag"
                            >
                              Accept
                            </button>
                            <button
                              type="button"
                              className={BTN_GHOST_CLASS}
                              disabled={triage.isPending}
                              onClick={() => triage.mutate({ id: f.id, status: "wontfix" })}
                              title="A conscious deferral — never re-flag"
                            >
                              Won't-fix
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className={BTN_GHOST_CLASS}
                            disabled={triage.isPending}
                            onClick={() => triage.mutate({ id: f.id, status: "open" })}
                            title="A regression resurfaced — track it again"
                          >
                            Reopen
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
