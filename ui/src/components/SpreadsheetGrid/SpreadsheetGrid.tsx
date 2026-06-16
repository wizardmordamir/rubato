import {
  DataEditor,
  type EditableGridCell,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type Item,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import type { CellScalar } from "cwip/excel-engine/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpreadsheetGridProps } from "./types";

// An Excel-like surface built on glide-data-grid: sheet tabs + a formula bar
// around the canvas grid. It is STATELESS with respect to truth — it renders
// whatever RevisionView the server produced; switching revisions/sheets is a prop
// swap. Editing only emits committed edits upward (the server is authoritative).

const scalarToDisplay = (v: CellScalar): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
};

// Coerce a formula-bar string back into a scalar, mirroring how the native
// glide overlay types cells (numbers stay numeric, TRUE/FALSE booleans).
const displayToScalar = (s: string): CellScalar => {
  const t = s.trim();
  if (t === "") return "";
  if (t.toUpperCase() === "TRUE") return true;
  if (t.toUpperCase() === "FALSE") return false;
  if (/^-?\d*\.?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return s;
};

const SpreadsheetGrid = ({ view, onSheetChange, readOnly, onCellEdit, className = "" }: SpreadsheetGridProps) => {
  const { columns, rows, formulas, hiddenRows, sheets, activeSheet } = view;
  const [selectedCell, setSelectedCell] = useState<Item | undefined>(undefined);
  const [colWidths, setColWidths] = useState<Record<number, number>>({});

  const gridColumns = useMemo<GridColumn[]>(
    () =>
      columns.map((c, i) => ({
        title: c.title || `Column ${i + 1}`,
        id: c.key,
        width: colWidths[i] ?? 160,
      })),
    [columns, colWidths],
  );

  const hidden = useMemo(() => new Set(hiddenRows ?? []), [hiddenRows]);

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const value = rows[row]?.[col] ?? null;
      const display = scalarToDisplay(value);
      const faded = hidden.has(row);
      if (typeof value === "boolean") {
        return {
          kind: GridCellKind.Boolean,
          data: value,
          allowOverlay: false,
          readonly: readOnly,
        };
      }
      if (typeof value === "number") {
        return {
          kind: GridCellKind.Number,
          data: value,
          displayData: display,
          allowOverlay: !readOnly,
          readonly: readOnly,
          themeOverride: faded ? { textDark: "#9ca3af" } : undefined,
        };
      }
      return {
        kind: GridCellKind.Text,
        data: display,
        displayData: display,
        allowOverlay: !readOnly,
        readonly: readOnly,
        themeOverride: faded ? { textDark: "#9ca3af" } : undefined,
      };
    },
    [rows, readOnly, hidden],
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      if (readOnly || !onCellEdit) return;
      let value: CellScalar;
      if (newValue.kind === GridCellKind.Boolean) value = Boolean(newValue.data);
      else if (newValue.kind === GridCellKind.Number) value = (newValue.data as number | undefined) ?? null;
      else value = (newValue.data as string) ?? "";
      onCellEdit({ row, col, value });
    },
    [readOnly, onCellEdit],
  );

  const selectedFormula = useMemo(() => {
    if (!selectedCell) return "";
    const [c, r] = selectedCell;
    const f = formulas?.[`${r},${c}`];
    if (f) return f;
    return scalarToDisplay(rows[r]?.[c] ?? null);
  }, [selectedCell, formulas, rows]);

  // Editable formula-bar value. Glide's canvas overlay editor doesn't open on a
  // touch tap (mobile can't double-click), so the formula bar doubles as a real
  // DOM input: tap a cell to select it, type here, Enter/blur to commit. Works
  // identically on desktop. Kept in sync whenever the selected cell/value changes
  // (incl. after a committed edit re-fetches the view), but never while typing.
  const [editValue, setEditValue] = useState("");
  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    setEditValue(selectedFormula);
    lastSentRef.current = null;
  }, [selectedFormula, selectedCell]);

  const commitEdit = () => {
    if (readOnly || !onCellEdit || !selectedCell) return;
    if (editValue === selectedFormula) return; // unchanged
    if (lastSentRef.current === editValue) return; // dedupe Enter-then-blur
    lastSentRef.current = editValue;
    const [c, r] = selectedCell;
    onCellEdit({ row: r, col: c, value: displayToScalar(editValue) });
  };

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      {/* Formula bar — read-only normally; an editable input when editing (the
          mobile-friendly way to edit a cell, since the canvas overlay needs a
          double-click the touch grid can't deliver). */}
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-800">
        <span className="select-none font-mono text-neutral-400">fx</span>
        {readOnly ? (
          <span className="truncate font-mono text-neutral-700 dark:text-neutral-200">
            {selectedFormula || <span className="text-neutral-400">—</span>}
          </span>
        ) : (
          <input
            className="min-w-0 flex-1 bg-transparent font-mono text-neutral-700 outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed dark:text-neutral-200"
            value={editValue}
            disabled={!selectedCell}
            placeholder={selectedCell ? "Type a value, then press Enter" : "Tap a cell to edit it"}
            enterKeyHint="done"
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setEditValue(selectedFormula);
                e.currentTarget.blur();
              }
            }}
          />
        )}
      </div>

      {/* Grid */}
      <div className="min-h-0 flex-1">
        {columns.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">This sheet is empty.</div>
        ) : (
          <DataEditor
            getCellContent={getCellContent}
            columns={gridColumns}
            rows={rows.length}
            rowMarkers="number"
            smoothScrollX
            smoothScrollY
            width="100%"
            height="100%"
            onCellEdited={readOnly ? undefined : onCellEdited}
            onGridSelectionChange={(sel) => setSelectedCell(sel.current?.cell)}
            onColumnResize={(_c, newSize, idx) => setColWidths((w) => ({ ...w, [idx]: newSize }))}
          />
        )}
      </div>

      {/* Sheet tabs */}
      {sheets.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-t border-neutral-200 bg-neutral-100 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800">
          {sheets.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSheetChange(s.id)}
              className={`whitespace-nowrap rounded-t px-3 py-1 text-xs ${
                s.id === activeSheet
                  ? "bg-white font-semibold text-accent shadow-sm dark:bg-neutral-900"
                  : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default SpreadsheetGrid;
