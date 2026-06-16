import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { Tooltip } from "../components";
import { type CellScalar, type GridTable, toScalar } from "./table";

/**
 * A read-only, Excel-like grid over a flat `GridTable`, built on the headless
 * @tanstack/react-table + @tanstack/react-virtual. Renders a plain HTML table
 * (so it styles with Tailwind / the app's `dark:` classes — no canvas theming),
 * virtualizes rows for large result sets, and supports column resize + click-to-
 * sort. Lazy-loaded via ./index. Read-only by design — these are result viewers.
 */

const display = (v: CellScalar): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
};

const ROW_HEIGHT = 30;

const SpreadsheetGrid = ({ table, height = 360 }: { table: GridTable; height?: number }) => {
  const [sorting, setSorting] = useState<SortingState>([]);
  const parentRef = useRef<HTMLDivElement>(null);

  const columns = useMemo<ColumnDef<CellScalar[]>[]>(
    () =>
      table.columns.map((title, i) => ({
        id: String(i),
        header: title || `Column ${i + 1}`,
        accessorFn: (row) => row[i],
        cell: (info) => display(toScalar(info.getValue())),
        size: 160,
        minSize: 56,
      })),
    [table.columns],
  );

  const tbl = useReactTable({
    data: table.rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    columnResizeMode: "onChange",
    enableColumnResizing: true,
  });

  const rows = tbl.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (table.columns.length === 0) {
    return <div className="p-4 text-sm text-gray-400">Nothing to show.</div>;
  }

  const totalWidth = tbl.getTotalSize();
  const vItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      style={{ height }}
      className="overflow-auto rounded-lg border border-gray-200 text-xs dark:border-gray-800"
    >
      <div style={{ width: totalWidth }} className="grid">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-gray-100 dark:bg-gray-800">
          {tbl.getHeaderGroups().map((hg) => (
            <div key={hg.id} className="flex">
              {hg.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <div
                    key={header.id}
                    style={{ width: header.getSize() }}
                    className="relative border-gray-200 border-b px-2 py-1.5 font-medium dark:border-gray-700"
                  >
                    <Tooltip content="Sort">
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        aria-label="Sort"
                        className="flex w-full items-center gap-1 truncate text-left font-mono hover:text-accent"
                      >
                        <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                        <span className="text-gray-400">{sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}</span>
                      </button>
                    </Tooltip>
                    {/* Resize handle */}
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle, not a control */}
                    <div
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      className="absolute top-0 right-0 h-full w-1 cursor-col-resize select-none hover:bg-accent/40"
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Virtualized rows */}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {vItems.map((vi) => {
            const row = rows[vi.index];
            return (
              <div
                key={row.id}
                style={{ position: "absolute", top: 0, transform: `translateY(${vi.start}px)`, width: totalWidth }}
                className="flex odd:bg-white even:bg-gray-50 dark:odd:bg-gray-900 dark:even:bg-gray-900/40"
              >
                {row.getVisibleCells().map((cell) => {
                  const v = cell.getValue();
                  const numeric = typeof v === "number";
                  return (
                    <Tooltip content={display(toScalar(v))}>
                      <div
                        key={cell.id}
                        style={{ width: cell.column.getSize(), height: ROW_HEIGHT }}
                        className={`truncate border-gray-100 border-b px-2 py-1 font-mono dark:border-gray-800/60 ${
                          numeric ? "text-right" : ""
                        }`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default SpreadsheetGrid;
