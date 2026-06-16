import type { MessageTrace, TraceStep } from "../../api";

// Each phase kind gets a hue so the timeline reads at a glance.
const KIND_COLOR: Record<TraceStep["kind"], string> = {
  index: "bg-gray-400",
  retrieval: "bg-sky-400",
  planner: "bg-violet-400",
  llm: "bg-amber-400",
  tool: "bg-emerald-400",
  answer: "bg-accent",
};

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

/**
 * The "what happened behind this answer" panel: a gantt-style timeline of the
 * ask pipeline (retrieval rounds, planner checks, tool calls, the LLM stream),
 * each bar offset/sized by when it ran and how long it took. Shown only when the
 * debug toggle is on and the message carries a trace.
 */
export function TracePanel({ trace }: { trace: MessageTrace }) {
  const total = Math.max(trace.totalMs, 1);
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs opacity-60">
        🐞 debug · {fmt(trace.totalMs)} · {trace.mode} · {trace.rounds} round{trace.rounds === 1 ? "" : "s"}
        {trace.toolCalls > 0 ? ` · ${trace.toolCalls} tool call${trace.toolCalls === 1 ? "" : "s"}` : ""}
      </summary>
      <div className="mt-1.5 space-y-1">
        {trace.model && <div className="font-mono text-xs opacity-50">model: {trace.model}</div>}
        {trace.steps.map((s) => {
          const left = (s.startMs / total) * 100;
          const width = Math.max((s.durationMs / total) * 100, 1.5);
          const failed = s.ok === false;
          return (
            <div key={`${s.startMs}-${s.label}`} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className={`truncate ${failed ? "text-red-500" : "opacity-80"}`}>
                  {s.label}
                  {failed ? " ⚠" : ""}
                  {s.detail ? <span className="opacity-50"> — {s.detail}</span> : null}
                </span>
                <span className="shrink-0 font-mono opacity-60">{fmt(s.durationMs)}</span>
              </div>
              <div className="mt-0.5 h-1 w-full rounded-full bg-gray-200/60 dark:bg-gray-700/50">
                <div
                  className={`h-1 rounded-full ${failed ? "bg-red-400" : KIND_COLOR[s.kind]}`}
                  style={{ marginLeft: `${left}%`, width: `${width}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
