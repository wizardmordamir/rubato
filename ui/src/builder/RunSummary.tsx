import type { AutomationRunRecord, StepResult } from "../api";
import { Alert } from "../components";
import { type ResultMap, StepDiagnostics } from "./StepList";

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Friendly name for a step result, special-casing the implicit start-URL goto. */
export function stepLabel(s: StepResult): string {
  return s.index === "start" ? "the Start URL" : `step ${s.index} (${s.action})`;
}

/** Sortable key for a dotted step index ("start" first, then 0,1,2.then.0,…). */
function indexKey(i: string): (number | string)[] {
  if (i === "start") return [-1];
  return i.split(".").map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/** Order step results the way they execute (numeric segments compare numerically). */
function byIndex(a: StepResult, b: StepResult): number {
  const ka = indexKey(a.index);
  const kb = indexKey(b.index);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

const STATUS_DOT: Record<StepResult["status"], string> = {
  passed: "text-emerald-500",
  failed: "text-red-500",
  running: "text-amber-500",
  skipped: "text-gray-400",
};
const STATUS_GLYPH: Record<StepResult["status"], string> = {
  passed: "✓",
  failed: "✗",
  running: "•",
  skipped: "⊘",
};

/**
 * A compact, always-on per-step log of a run — every step, its outcome, the
 * selector it acted on, how long it took, and (on failure) the error line.
 * Unlike the builder's StepList this needs no editor, so it rides along anywhere
 * a run happens (the list, the read-only view) and answers "did it even try to
 * fill that field?" at a glance. After a run it reads the authoritative recorded
 * steps; while running it reads the live results streaming in over /ws.
 */
export function RunStepLog({
  running,
  results,
  run,
}: {
  running: boolean;
  results: ResultMap;
  run: AutomationRunRecord | null;
}) {
  const steps: StepResult[] =
    !running && run ? run.steps : Object.values(results).filter((r) => r.status !== "running").sort(byIndex);
  if (steps.length === 0) return null;

  // An automation with no real steps only navigates to its start URL — call that
  // out so "nothing happened" reads as "there was nothing to do", not a silent bug.
  const onlyStart = steps.length === 1 && steps[0].index === "start";

  return (
    <details open className="rounded-lg border border-gray-200 dark:border-gray-700">
      <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-gray-600 select-none dark:text-gray-300">
        Step log ({steps.length})
      </summary>
      <ol className="max-h-72 space-y-1 overflow-auto border-t border-gray-100 px-3 py-2 dark:border-gray-800">
        {steps.map((s) => (
          <li key={s.index} className="text-xs">
            <div className="flex items-baseline gap-2">
              <span className={`${STATUS_DOT[s.status]} font-bold`} aria-hidden>
                {STATUS_GLYPH[s.status]}
              </span>
              <span className="text-gray-700 dark:text-gray-200">{stepLabel(s)}</span>
              {s.selector ? <span className="truncate font-mono text-gray-400">{s.selector}</span> : null}
              <span className="ml-auto shrink-0 text-gray-400">{fmtMs(s.durationMs)}</span>
            </div>
            {s.error ? <div className="mt-0.5 ml-5 text-red-600 dark:text-red-400">{firstLine(s.error)}</div> : null}
          </li>
        ))}
      </ol>
      {onlyStart && (
        <p className="border-t border-gray-100 px-3 py-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
          This automation has no steps yet — it only opened the start URL. Record a flow or add steps (e.g. fill the
          login fields, click a button) so the run does something.
        </p>
      )}
    </details>
  );
}

/** First line of a possibly multi-line error (the actionable summary). */
function firstLine(s: string): string {
  return s.split("\n", 1)[0];
}

/**
 * The single, obvious place to review a run's outcome. The per-step list shows
 * each visible step, but the implicit start-URL navigation (index "start") has
 * no row to render in, and a browser/launch failure produces no steps at all —
 * so a failed run could leave nothing on screen but a transient toast. This panel
 * always states the verdict and, on failure, surfaces the failing step's full
 * diagnostics (error, browser logs, screenshot) right here.
 */
export function RunSummary({ running, run }: { running: boolean; run: AutomationRunRecord | null }) {
  if (running) {
    return <Alert tone="warning">Running… each step updates live below.</Alert>;
  }
  if (!run) return null;

  const failed = run.status === "failed";
  const failStep = run.steps.find((s) => s.status === "failed");
  const passed = run.steps.filter((s) => s.status === "passed").length;

  return (
    <Alert
      tone={failed ? "error" : "success"}
      title={
        <>
          {failed ? "✗ Run failed" : "✓ Run passed"} · {passed}/{run.steps.length} step{run.steps.length === 1 ? "" : "s"} passed ·{" "}
          {fmtMs(run.durationMs)}
        </>
      }
    >
      {failed && !failStep && (
        <p className="text-xs">
          The run failed before any step completed — the browser couldn't start or navigate. Uncheck <b>headless</b> and run
          again to watch what happens.
        </p>
      )}

      {failStep && (
        <div className="text-xs">
          <div>
            Failed at <b>{stepLabel(failStep)}</b>
            {failStep.selector ? (
              <>
                {" "}
                — <span className="font-mono">{failStep.selector}</span>
              </>
            ) : null}
          </div>
          {/* Reuses the per-step readout: error, final URL, browser logs, screenshot. */}
          <StepDiagnostics result={failStep} />
        </div>
      )}
    </Alert>
  );
}
