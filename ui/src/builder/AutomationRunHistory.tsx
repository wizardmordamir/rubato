// Past runs of an automation, with the captures testers asked for. Each run is
// collapsible; expanding it shows the steps that produced something worth seeing
// — a `snapshot` step's HTML + image, or the page state at the moment a step
// failed — reusing the same StepDiagnostics readout as a live run. Refreshes
// automatically: useLive invalidates ["automationRuns"] when a run completes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { runToMoments } from "@shared/timeline";
import { useState } from "react";
import type { AutomationRunRecord, StepResult } from "../api";
import { clearAutomationRuns, deleteAutomationRun, fetchAutomationRuns } from "../api";
import { Badge, CARD_CLASS, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";
import { stepLabel } from "./RunSummary";
import { StepDiagnostics } from "./StepList";
import { TimelinePlayer } from "./TimelinePlayer";

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Steps worth surfacing in history: a capture (snapshot / failure shot / HTML) or a failure. */
function notableSteps(steps: StepResult[]): StepResult[] {
  return steps.filter(
    (s) => s.action === "snapshot" || s.status === "failed" || s.screenshotPath || s.htmlPath || s.screenshot,
  );
}

function RunEntry({ run, onDelete }: { run: AutomationRunRecord; onDelete: (id: number) => void }) {
  const confirm = useConfirm();
  const failed = run.status === "failed";
  const passed = run.steps.filter((s) => s.status === "passed").length;
  const notable = notableSteps(run.steps);
  const when = new Date(run.startedAt).toLocaleString();
  const [play, setPlay] = useState(false);

  return (
    <details className={`${CARD_CLASS} px-3 py-2`}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
        <Badge tone={failed ? "error" : "success"}>{failed ? "✗ failed" : "✓ passed"}</Badge>
        <span className="text-gray-500">{when}</span>
        <span className="text-xs text-gray-400">
          {passed}/{run.steps.length} step{run.steps.length === 1 ? "" : "s"} · {fmtMs(run.durationMs)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {notable.length > 0 && (
            <span className="text-xs text-gray-400">
              {notable.length} capture{notable.length === 1 ? "" : "s"}
            </span>
          )}
          <Tooltip content="Delete this run + its outputs">
            <button
              type="button"
              // Inside <summary>: stop the click from toggling the details open/closed.
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (await confirm({ prompt: "Delete this run and its saved outputs?", confirmText: "Delete" }))
                  onDelete(run.id);
              }}
              aria-label="Delete this run + its outputs"
              className="rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 hover:text-red-600 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              ✕
            </button>
          </Tooltip>
        </span>
      </summary>
      <div className="mt-2 space-y-2">
        {/* Step through / auto-play the run's whole timeline, or read the notable steps. */}
        <button
          type="button"
          onClick={() => setPlay((p) => !p)}
          className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          {play ? "Hide player" : "▶ Play timeline"}
        </button>
        {play ? (
          <div className="h-[28rem] rounded-lg border border-gray-200 dark:border-gray-800">
            <TimelinePlayer moments={runToMoments(run)} correlationId={run.correlationId} />
          </div>
        ) : notable.length === 0 ? (
          <p className="text-xs text-gray-400">No snapshots or failures recorded for this run.</p>
        ) : (
          notable.map((s) => (
            <div key={s.index} className="rounded-lg border border-gray-200 p-2 dark:border-gray-800">
              <div className="flex items-center gap-2 text-xs">
                <Tooltip content={s.status}>
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${s.status === "failed" ? "bg-red-500" : "bg-emerald-500"}`}
                  />
                </Tooltip>
                <span className="font-medium text-gray-600 dark:text-gray-300">{stepLabel(s)}</span>
              </div>
              <StepDiagnostics result={s} />
            </div>
          ))
        )}
      </div>
    </details>
  );
}

/** The "Previous runs" section for an automation's detail page. */
export function AutomationRunHistory({ name }: { name: string }) {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { data = [], isLoading } = useQuery({
    queryKey: ["automationRuns", name],
    queryFn: () => fetchAutomationRuns(name),
    enabled: !!name,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["automationRuns", name] });
  const del = useMutation({ mutationFn: deleteAutomationRun, onSuccess: invalidate });
  const clear = useMutation({
    mutationFn: () => clearAutomationRuns(name),
    onSuccess: (r) => {
      notify(`Deleted ${r.deleted} run${r.deleted === 1 ? "" : "s"} + outputs`, "success");
      invalidate();
    },
  });

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-500">Previous runs</span>
        {data.length > 0 && (
          <button
            type="button"
            onClick={async () => {
              if (
                await confirm({
                  prompt: `Delete all ${data.length} runs of "${name}" and their saved outputs?`,
                  confirmText: "Delete all",
                })
              )
                clear.mutate();
            }}
            disabled={clear.isPending}
            className="ml-auto rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100 hover:text-red-600 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
          >
            Clear all runs
          </button>
        )}
      </div>
      {isLoading ? (
        <p className="text-gray-400">Loading…</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-gray-400">No runs yet — run this automation to capture snapshots here.</p>
      ) : (
        <div className="space-y-2">
          {data.map((run) => (
            <RunEntry key={run.id} run={run} onDelete={del.mutate} />
          ))}
        </div>
      )}
    </div>
  );
}
