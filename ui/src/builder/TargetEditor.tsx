import { useState } from "react";
import type { Target, TargetKind } from "@shared/automation";
import { Dropdown, Tooltip } from "../components";
import { useBuilder } from "./model";

const KINDS: TargetKind[] = ["role", "testid", "text", "label", "placeholder", "id", "class", "href", "css"];

const input =
  "rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30 dark:border-gray-700 dark:bg-gray-900";

/** Edit one Target: kind + value (+ role name / exact / nth), with Pick + Test. */
export function TargetEditor({ target, onChange }: { target: Target; onChange: (t: Target) => void }) {
  const { launched, pickInto, picking, test } = useBuilder();
  const [result, setResult] = useState<string | null>(null);
  const set = (patch: Partial<Target>) => onChange({ ...target, ...patch });

  const runTest = async () => {
    setResult("…");
    try {
      const { matchCount, visible } = await test(target);
      setResult(matchCount === 0 ? "no match" : `${matchCount} match${matchCount > 1 ? "es" : ""}${visible ? ", visible" : ""}`);
    } catch (e) {
      setResult(e instanceof Error ? e.message : "error");
    }
  };

  return (
    <div className="rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-900/40">
      <div className="flex flex-wrap items-center gap-1.5">
        <Dropdown
          aria-label="Target kind"
          value={target.kind}
          onChange={(v) => set({ kind: v as TargetKind })}
          options={KINDS.map((k) => ({ value: k, label: k }))}
        />
        <input
          value={target.value}
          onChange={(e) => set({ value: e.target.value })}
          placeholder={target.kind === "role" ? "button" : "selector value"}
          className={`${input} min-w-32 flex-1`}
        />
        {target.kind === "role" && (
          <input
            value={target.name ?? ""}
            onChange={(e) => set({ name: e.target.value || undefined })}
            placeholder="name (e.g. Save)"
            className={`${input} w-28`}
          />
        )}
        <Tooltip content={launched ? "Click an element in the browser" : "Launch the browser first"}>
          <button
            type="button"
            disabled={!launched}
            onClick={() => pickInto(onChange)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-xs transition-colors hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
          >
            {picking ? "Picking…" : "Pick"}
          </button>
        </Tooltip>
        <button
          type="button"
          disabled={!launched || !target.value}
          onClick={runTest}
          className="rounded-lg border border-gray-300 px-2 py-1 text-xs transition-colors hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          Test
        </button>
      </div>
      <div className="mt-1 flex items-center gap-3 text-xs text-gray-400">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={!!target.exact} onChange={(e) => set({ exact: e.target.checked || undefined })} />
          exact
        </label>
        <label className="flex items-center gap-1">
          nth
          <input
            type="number"
            value={target.nth ?? ""}
            onChange={(e) => set({ nth: e.target.value === "" ? undefined : Number(e.target.value) })}
            className={`${input} w-14`}
          />
        </label>
        {result && <span className={result === "no match" || result.includes("error") ? "text-red-500" : "text-emerald-600"}>{result}</span>}
      </div>
    </div>
  );
}
