import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { archiveRun, fetchRuns, runCommand } from "../api";
import { useApiMutation } from "../apiHooks";
import { Badge, BTN_GHOST_CLASS, CARD_CLASS, PageHeading, Tooltip } from "../components";
import { OutputFileRow } from "../OutputFileRow";
import { reportCsvPath } from "../ReportLinks";
import { useToast } from "../toast";

function when(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return new Date(ms).toLocaleString();
}

export function RunsPage() {
  const { notify } = useToast();
  // Poll so the feed updates as commands run from the Commands page or the terminal.
  const { data = [] } = useQuery({ queryKey: ["runs"], queryFn: fetchRuns, refetchInterval: 3000 });

  const archive = useApiMutation({
    mutationFn: (_c, command: string) => archiveRun(command),
    successToast: (_a, command) => `Archived "${command}"`,
    invalidateKeys: [["archives"]],
  });

  // A rerun "succeeds" even on a non-zero exit, so the toast variant depends on the
  // result — handled in onSuccess rather than the always-success successToast.
  const rerun = useApiMutation({
    mutationFn: (_c, { command, args }: { command: string; args: string[] }) => runCommand(command, args),
    invalidateKeys: [["runs"]],
    onSuccess: (r) => notify(`${r.command} → exit ${r.exitCode}`, r.exitCode === 0 ? "success" : "error"),
  });

  return (
    <div>
      <PageHeading title="Runs" count={data.length} />
      <p className="mb-3 text-xs text-gray-400">
        Latest run of each command. Archive one to keep it before it's replaced.
      </p>
      {data.length === 0 && <p className="text-gray-400">No runs yet — run a command from the Commands page.</p>}
      <ul className="space-y-2">
        {data.map((r) => (
          <li key={r.id} className={`${CARD_CLASS} p-3`}>
            <div className="flex items-center gap-2">
              <Link
                to={`/commands/${encodeURIComponent(r.command)}`}
                className="font-medium hover:text-accent hover:underline"
                title={`Open ${r.command} details`}
              >
                {r.command}
              </Link>
              {r.args.length > 0 && <span className="font-mono text-xs text-gray-500">{r.args.join(" ")}</span>}
              <Badge tone={r.exitCode === 0 ? "success" : "error"} className="ml-auto">
                exit {r.exitCode}
              </Badge>
              <span className="text-xs text-gray-400">
                {when(r.startedAt)} · {r.durationMs}ms
              </span>
              <Tooltip
                multiline
                content="Re-executes this command with the exact same arguments right now, recording a new run. It replaces this command's latest run in the feed (a non-zero exit still counts as a run)."
              >
                <button
                  type="button"
                  onClick={() => rerun.mutate({ command: r.command, args: r.args })}
                  disabled={rerun.isPending}
                  className={`${BTN_GHOST_CLASS} px-2 py-0.5 text-xs`}
                >
                  Rerun
                </button>
              </Tooltip>
              <Tooltip
                multiline
                content="Saves a permanent copy of this run to Archives so it's kept before it's overwritten by the command's next run (the feed only holds the latest run of each command)."
              >
                <button
                  type="button"
                  onClick={() => archive.mutate(r.command)}
                  disabled={archive.isPending}
                  className={`${BTN_GHOST_CLASS} px-2 py-0.5 text-xs`}
                >
                  Archive
                </button>
              </Tooltip>
            </div>
            {r.outputPath && <OutputFileRow path={r.outputPath} />}
            {r.diagnosticPath && <OutputFileRow path={r.diagnosticPath} />}
            {r.reportPath && <OutputFileRow path={r.reportPath} />}
            {r.reportPath && <OutputFileRow path={reportCsvPath(r.reportPath)} />}
            {r.output.trim() && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-gray-500 hover:text-accent">output</summary>
                <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-gray-100 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-gray-800/60">
                  {r.output}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
