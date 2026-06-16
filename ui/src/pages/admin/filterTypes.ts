import type { ColumnInfo, FilterOp } from "../../api";

/** Coarse UI kind for a column, derived from its name + declared SQLite type. */
export type FilterKind = "text" | "number" | "date" | "boolean";

const BOOLEANISH = new Set(["archived", "favorite", "read", "done", "active", "enabled", "pinned", "background"]);

/** Derive the filter UI kind for a column (drives which operators + input we show). */
export function deriveKind(col: ColumnInfo): FilterKind {
  const name = col.name.toLowerCase();
  const type = (col.type || "").toUpperCase();
  if (name.endsWith("_at") || name.endsWith("_date") || name.includes("date")) return "date";
  const numeric = /INT|REAL|NUM|FLOA|DOUB/.test(type);
  if (numeric && (/^(is|has)_/.test(name) || BOOLEANISH.has(name))) return "boolean";
  if (numeric) return "number";
  return "text";
}

/** One selectable operator: its op, a label, and whether it takes no value. */
export interface OpChoice {
  op: FilterOp;
  label: string;
  nullary?: boolean;
}

const NULLARY: OpChoice[] = [
  { op: "isnull", label: "is empty", nullary: true },
  { op: "isnotnull", label: "is not empty", nullary: true },
];

/** Operators offered for each kind. */
export const OPS_BY_KIND: Record<FilterKind, OpChoice[]> = {
  text: [
    { op: "contains", label: "contains" },
    { op: "notcontains", label: "does not contain" },
    { op: "eq", label: "equals" },
    { op: "neq", label: "not equals" },
    { op: "startswith", label: "starts with" },
    { op: "endswith", label: "ends with" },
    ...NULLARY,
  ],
  number: [
    { op: "eq", label: "=" },
    { op: "neq", label: "≠" },
    { op: "gt", label: ">" },
    { op: "gte", label: "≥" },
    { op: "lt", label: "<" },
    { op: "lte", label: "≤" },
    ...NULLARY,
  ],
  date: [
    { op: "eq", label: "on" },
    { op: "gte", label: "on or after" },
    { op: "lte", label: "on or before" },
    { op: "gt", label: "after" },
    { op: "lt", label: "before" },
    ...NULLARY,
  ],
  boolean: [
    { op: "eq", label: "is" },
    ...NULLARY,
  ],
};
