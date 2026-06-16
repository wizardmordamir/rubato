import { jsonToCsv } from "@shared/tools/json";

/**
 * Shared shape for the result-view switcher: a flat, read-only table of scalar
 * cells. Every result surface (Splunk `{fields, rows}`, the DB viewer
 * `{columns, rows}`, a Services `result: unknown`) normalizes into this so the
 * Grid / JSON / CSV views can be driven from one component.
 */

export type CellScalar = string | number | boolean | null;

export interface GridTable {
  columns: string[];
  rows: CellScalar[][];
}

/** Coerce an arbitrary value into a cell scalar (objects → compact JSON). */
export function toScalar(v: unknown): CellScalar {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Build a table from record rows, deriving columns (first-seen key order) when not given. */
export function tableFromRecords(rows: Array<Record<string, unknown>>, columns?: string[]): GridTable {
  let cols = columns;
  if (!cols) {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const r of rows) {
      for (const k of Object.keys(r ?? {})) {
        if (!seen.has(k)) {
          seen.add(k);
          order.push(k);
        }
      }
    }
    cols = order;
  }
  const finalCols = cols;
  return { columns: finalCols, rows: rows.map((r) => finalCols.map((c) => toScalar(r?.[c]))) };
}

/**
 * Best-effort table from an unknown result (the Services tab). Returns null when
 * the value isn't tabular, so the caller can fall back to JSON-only.
 *  - array of objects → one column per union-of-keys
 *  - array of primitives → a single "value" column
 *  - anything else → null
 */
export function tableFromUnknown(data: unknown): GridTable | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const allObjects = data.every((d) => d !== null && typeof d === "object" && !Array.isArray(d));
  if (allObjects) return tableFromRecords(data as Array<Record<string, unknown>>);
  // Mixed/primitive array → single column.
  return { columns: ["value"], rows: data.map((d) => [toScalar(d)]) };
}

/** Render a table as CSV text (RFC-4180-ish), reusing the shared json→csv helper. */
export function tableToCsv(table: GridTable): string {
  const records = table.rows.map((r) => Object.fromEntries(table.columns.map((c, i) => [c, r[i]])));
  const res = jsonToCsv(JSON.stringify(records), { delimiter: "," });
  return res.ok ? res.output : "";
}
