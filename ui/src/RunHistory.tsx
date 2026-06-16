import { useQuery } from "@tanstack/react-query";
import { fetchRunHistory } from "./api";
import { Badge, OpenPathButton } from "./components";
import { ReportLinks } from "./ReportLinks";

/** Per-command run history: every recorded run with its result, output, and time. */
export function RunHistory({ command }: { command: string }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ["runHistory", command],
    queryFn: () => fetchRunHistory(command),
  });

  if (isLoading) return <p className="text-xs text-gray-400">Loading history…</p>;
  if (data.length === 0) return <p className="text-xs text-gray-400">No runs recorded yet.</p>;

  return (
    <ul className="space-y-1.5">
      {data.map((r) => (
        <li key={r.id} className="rounded-md border border-gray-200 p-2 text-xs dark:border-gray-800">
          <div className="flex items-center gap-2">
            {r.args.length > 0 && <span className="truncate font-mono text-gray-500">{r.args.join(" ")}</span>}
            <Badge tone={r.exitCode === 0 ? "success" : "error"} className="ml-auto shrink-0">
              exit {r.exitCode}
            </Badge>
            <span className="shrink-0 text-gray-400">
              {new Date(r.startedAt).toLocaleString()} · {r.durationMs}ms
            </span>
            {r.outputPath && (
              <OpenPathButton path={r.outputPath} title={`Open output ${r.outputPath} in editor`} />
            )}
            {r.diagnosticPath && (
              <OpenPathButton path={r.diagnosticPath} title={`Open diagnostic ${r.diagnosticPath} in editor`} />
            )}
          </div>
          {r.output.trim() && (
            <details className="mt-1">
              <summary className="cursor-pointer text-gray-500 hover:text-accent">output</summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-gray-100 p-2 font-mono whitespace-pre-wrap dark:bg-gray-800/60">
                {r.output}
              </pre>
            </details>
          )}
          {r.reportPath && <ReportLinks reportPath={r.reportPath} className="mt-1.5" />}
        </li>
      ))}
    </ul>
  );
}
