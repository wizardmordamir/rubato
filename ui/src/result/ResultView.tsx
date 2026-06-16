import { useMemo, useState } from "react";
import { CARD_CLASS, Tooltip } from "../components";
import { downloadText } from "./download";
import { SpreadsheetGrid } from "./index";
import { type GridTable, tableToCsv } from "./table";
import { TypesView } from "./TypesView";

/**
 * Result-view switcher: shows a result as a **Grid** (Excel-like canvas sheet),
 * **JSON**, generated **TS** types, or downloads it as **CSV**. The grid tab
 * appears only when the data is tabular (`table` non-null with rows); the TS tab
 * appears for any object/array result. One shared surface for the Services,
 * Splunk, ServiceNow, Queries, and DB-viewer result panes.
 */

type View = "grid" | "json" | "types";

const TAB_BASE = "-mb-px border-b-2 px-3 py-1 text-xs transition-colors";
const TAB_ON = "border-accent font-medium text-accent";
const TAB_OFF = "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200";

export function ResultView({
  json,
  table,
  filename = "result",
  count,
  gridHeight = 380,
}: {
  /** The raw value shown in the JSON view. */
  json: unknown;
  /** Normalized table for the Grid + CSV views, or null when not tabular. */
  table: GridTable | null;
  /** Base name for the CSV download (no extension). */
  filename?: string;
  /** Optional row count shown in the header. */
  count?: number;
  gridHeight?: number;
}) {
  const hasGrid = !!table && table.rows.length > 0;
  const hasTypes = json !== null && typeof json === "object";
  const [view, setView] = useState<View>(hasGrid ? "grid" : "json");
  const active: View = (view === "grid" && !hasGrid) || (view === "types" && !hasTypes) ? "json" : view;
  const csv = useMemo(() => (hasGrid && table ? tableToCsv(table) : ""), [hasGrid, table]);

  return (
    <div className={`${CARD_CLASS} p-0`}>
      <div className="flex items-center gap-1 border-gray-200 border-b px-2 dark:border-gray-800">
        {hasGrid && (
          <button
            type="button"
            onClick={() => setView("grid")}
            className={`${TAB_BASE} ${active === "grid" ? TAB_ON : TAB_OFF}`}
          >
            Grid
          </button>
        )}
        <button
          type="button"
          onClick={() => setView("json")}
          className={`${TAB_BASE} ${active === "json" ? TAB_ON : TAB_OFF}`}
        >
          JSON
        </button>
        {hasTypes && (
          <Tooltip content="Generate a TypeScript type from this result">
            <button
              type="button"
              onClick={() => setView("types")}
              className={`${TAB_BASE} ${active === "types" ? TAB_ON : TAB_OFF}`}
            >
              TS
            </button>
          </Tooltip>
        )}
        <div className="ml-auto flex items-center gap-2 py-1 text-xs text-gray-400">
          {typeof count === "number" && <span>{count === 1 ? "1 row" : `${count} rows`}</span>}
          {hasGrid && (
            <Tooltip content="Download as CSV (opens in Excel)">
              <button
                type="button"
                onClick={() => downloadText(`${filename}.csv`, csv, "text/csv")}
                className="text-gray-500 hover:text-accent"
              >
                CSV ↓
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {active === "grid" && table ? (
        <div className="p-2">
          <SpreadsheetGrid table={table} height={gridHeight} />
        </div>
      ) : active === "types" ? (
        <TypesView data={json} typeName={filename} filename={filename} />
      ) : (
        <pre className="max-h-[28rem] overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
          {JSON.stringify(json, null, 2)}
        </pre>
      )}
    </div>
  );
}
