import type { KV } from "@shared/request/model";
import { BTN_GHOST_CLASS, FIELD_CLASS, Tooltip } from "../../components";

const emptyRow = (): KV => ({ key: "", value: "", enabled: true });

/** A compact enable/key/value/remove row editor (params, headers, form, vars). */
export function KvEditor({
  rows,
  onChange,
  keyPlaceholder = "key",
  valuePlaceholder = "value",
}: {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const set = (i: number, patch: Partial<KV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and editable
        <div key={i} className="flex items-center gap-1.5">
          <Tooltip content="enabled">
            <input
              type="checkbox"
              aria-label="enabled"
              checked={r.enabled}
              onChange={(e) => set(i, { enabled: e.target.checked })}
            />
          </Tooltip>
          <input
            className={`${FIELD_CLASS} flex-1 py-1 font-mono`}
            placeholder={keyPlaceholder}
            value={r.key}
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <input
            className={`${FIELD_CLASS} flex-1 py-1 font-mono`}
            placeholder={valuePlaceholder}
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className={BTN_GHOST_CLASS} onClick={() => onChange([...rows, emptyRow()])}>
        + add
      </button>
    </div>
  );
}
