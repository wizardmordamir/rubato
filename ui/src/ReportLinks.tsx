/**
 * View / open the structured data report a command produced — the
 * `<command>.report.json` a run attaches as `reportPath`, plus its `.report.csv`
 * sibling. Each is a shared `OutputFileRow`: viewable inline (pretty JSON / a CSV
 * table via FileViewer), openable in the editor (code/cursor — handy for the
 * JSON), copyable, and downloadable from the viewer.
 *
 * Surfaced wherever a run's result shows on the Commands page — the run-command
 * modal, a saved command's latest result, and the per-command run history — so a
 * report command (appstatus, findchanges, appall, …) is readable straight from
 * there, the same way the Runs page already shows it.
 */
import { IconFileText } from "./icons";
import { OutputFileRow } from "./OutputFileRow";

/**
 * The `.report.csv` sibling of a report's `.report.json` path. Mirrors the
 * `REPORT_SUFFIX` convention in `src/lib/dataReport.ts` (the writer always emits
 * the pair together); kept UI-local because that module is Bun-only.
 */
export function reportCsvPath(jsonPath: string): string {
  return jsonPath.replace(/\.report\.json$/, ".report.csv");
}

/** The view/open affordances for one run's structured data report (JSON + CSV pair). */
export function ReportLinks({ reportPath, className = "" }: { reportPath: string; className?: string }) {
  return (
    <div className={`rounded-md border border-gray-200 p-2 dark:border-gray-800 ${className}`}>
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
        <IconFileText size={12} />
        Data report
      </div>
      <OutputFileRow path={reportPath} />
      <OutputFileRow path={reportCsvPath(reportPath)} />
    </div>
  );
}
