import { useState } from "react";
import type { ColumnInfo, QueryFilter } from "../../api";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, FIELD_CLASS, Tooltip } from "../../components";
import { deriveKind, OPS_BY_KIND } from "./filterTypes";

/** A draft filter row in the builder (op may not need a value). */
interface Draft {
  column: string;
  op: QueryFilter["op"];
  value: string;
}

function opsFor(columns: ColumnInfo[], column: string) {
  const col = columns.find((c) => c.name === column);
  return col ? OPS_BY_KIND[deriveKind(col)] : OPS_BY_KIND.text;
}

/**
 * Build a list of column filters and apply them. Each row is column + operator
 * (+ value unless the op is nullary). "Apply" hands the validated filters up;
 * "Clear" resets to none.
 */
export function FilterBuilder({ columns, onApply }: { columns: ColumnInfo[]; onApply: (filters: QueryFilter[]) => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);

  const add = () =>
    setDrafts((d) => {
      const column = columns[0]?.name ?? "";
      return [...d, { column, op: opsFor(columns, column)[0]?.op ?? "contains", value: "" }];
    });

  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts((d) => d.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const remove = (i: number) => setDrafts((d) => d.filter((_, idx) => idx !== i));

  const apply = () => {
    const filters: QueryFilter[] = drafts.map((d) => {
      const choice = opsFor(columns, d.column).find((o) => o.op === d.op);
      return choice?.nullary ? { column: d.column, op: d.op } : { column: d.column, op: d.op, value: d.value };
    });
    onApply(filters);
  };

  const clear = () => {
    setDrafts([]);
    onApply([]);
  };

  return (
    <div className="space-y-2">
      {drafts.map((d, i) => {
        const ops = opsFor(columns, d.column);
        const nullary = ops.find((o) => o.op === d.op)?.nullary;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: draft rows are positional and ephemeral.
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              value={d.column}
              onChange={(e) => {
                const column = e.target.value;
                update(i, { column, op: opsFor(columns, column)[0]?.op ?? "contains" });
              }}
              className={`${FIELD_CLASS} w-auto py-1`}
            >
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              value={d.op}
              onChange={(e) => update(i, { op: e.target.value as QueryFilter["op"] })}
              className={`${FIELD_CLASS} w-auto py-1`}
            >
              {ops.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {!nullary && (
              <input
                value={d.value}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder="value"
                className={`${FIELD_CLASS} w-40 py-1`}
              />
            )}
            <Tooltip content="Remove">
              <button type="button" onClick={() => remove(i)} className="text-gray-400 hover:text-rose-500" aria-label="Remove">
                ✕
              </button>
            </Tooltip>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <button type="button" onClick={add} className={`${BTN_GHOST_CLASS} px-2 py-1 text-xs`}>
          + filter
        </button>
        <button type="button" onClick={apply} className={`${BTN_PRIMARY_CLASS} px-3 py-1 text-xs`}>
          Apply
        </button>
        {drafts.length > 0 && (
          <button type="button" onClick={clear} className={`${BTN_GHOST_CLASS} px-2 py-1 text-xs`}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
