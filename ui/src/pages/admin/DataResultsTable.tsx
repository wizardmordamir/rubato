import { useMemo, useState } from "react";
import type { QueryResult } from "../../api";
import { BTN_GHOST_CLASS, Tooltip } from "../../components";
import { downloadText } from "../../result/download";
import { SpreadsheetGrid } from "../../result/index";
import { tableFromRecords, tableToCsv } from "../../result/table";
import { TypesView } from "../../result/TypesView";

/** Render a SQL cell value: null → '∅', objects → JSON, else string (truncated). */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

type View = "table" | "sheet" | "json" | "ts";

const VIEW_LABEL: Record<View, string> = { table: "Table", sheet: "Sheet", json: "JSON", ts: "TS" };

const TAB_BASE = "-mb-px border-b-2 px-2 py-0.5 text-xs transition-colors";
const TAB_ON = "border-accent font-medium text-accent";
const TAB_OFF = "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200";

/**
 * Paginated, read-only results for a table query, viewable four ways: the classic
 * HTML **Table** (with column types), an Excel-like **Sheet** (the sortable,
 * virtualized grid), raw **JSON**, or an auto-generated **TS** type inferred from
 * the rows — plus a CSV download of the page. Pagination is page-level, so its
 * controls stay put across all views.
 */
export function DataResultsTable({ result, onPage }: { result: QueryResult; onPage: (offset: number) => void }) {
  const { columns, rows, total, limit, offset } = result;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rows.length, total);
  const [view, setView] = useState<View>("table");

  const colNames = useMemo(() => columns.map((c) => c.name), [columns]);
  const table = useMemo(() => tableFromRecords(rows, colNames), [rows, colNames]);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <span>
          {from}–{to} of {total}
        </span>
        <div className="flex items-center border-gray-200 border-b dark:border-gray-800">
          {(["table", "sheet", "json", "ts"] as View[]).map((v) =>
            v === "ts" ? (
              <Tooltip key={v} content="Generate a TypeScript type from these rows">
                <button
                  type="button"
                  onClick={() => setView(v)}
                  className={`${TAB_BASE} ${view === v ? TAB_ON : TAB_OFF}`}
                >
                  {VIEW_LABEL[v]}
                </button>
              </Tooltip>
            ) : (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`${TAB_BASE} ${view === v ? TAB_ON : TAB_OFF}`}
              >
                {VIEW_LABEL[v]}
              </button>
            ),
          )}
        </div>
        <Tooltip content="Download this page as CSV (opens in Excel)">
          <button
            type="button"
            disabled={rows.length === 0}
            onClick={() => downloadText(`${result.table}.csv`, tableToCsv(table), "text/csv")}
            className="text-gray-500 hover:text-accent disabled:opacity-40"
          >
            CSV ↓
          </button>
        </Tooltip>
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => onPage(Math.max(0, offset - limit))}
            className={`${BTN_GHOST_CLASS} px-2 py-0.5 text-xs disabled:opacity-40`}
          >
            ← Prev
          </button>
          <button
            type="button"
            disabled={offset + limit >= total}
            onClick={() => onPage(offset + limit)}
            className={`${BTN_GHOST_CLASS} px-2 py-0.5 text-xs disabled:opacity-40`}
          >
            Next →
          </button>
        </div>
      </div>

      {view === "sheet" ? (
        <SpreadsheetGrid table={table} height={Math.min(window.innerHeight * 0.55, 36 + rows.length * 32 + 40)} />
      ) : view === "ts" ? (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800">
          <TypesView data={rows} typeName={`${result.table}_row`} filename={result.table} maxHeight="55vh" />
        </div>
      ) : view === "json" ? (
        <pre className="max-h-[55vh] overflow-auto rounded-lg border border-gray-200 p-3 font-mono text-xs whitespace-pre-wrap dark:border-gray-800">
          {JSON.stringify(rows, null, 2)}
        </pre>
      ) : (
        <div className="max-h-[55vh] overflow-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-gray-100 dark:bg-gray-800">
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.name}
                    className="border-b border-gray-200 px-2 py-1.5 text-left font-medium dark:border-gray-700"
                  >
                    <span className="font-mono">{c.name}</span>
                    <span className="ml-1 font-normal text-gray-400">{c.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: query rows have no stable id; index is fine for a read-only grid.
                <tr key={i} className="odd:bg-white even:bg-gray-50 dark:odd:bg-gray-900 dark:even:bg-gray-900/40">
                  {columns.map((c) => (
                    <td
                      key={c.name}
                      className="border-b border-gray-100 px-2 py-1 align-top font-mono whitespace-pre-wrap dark:border-gray-800"
                    >
                      {cell(row[c.name])}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length || 1} className="px-2 py-3 text-center text-gray-400">
                    no rows
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
