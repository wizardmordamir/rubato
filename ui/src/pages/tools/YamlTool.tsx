import { formatYaml } from "@shared/tools/yaml";
import { useMemo, useState } from "react";
import { FIELD_CLASS } from "../../components";
import { ErrorNote, Field, OutputBox, TOOL_TEXTAREA_CLASS } from "./toolkit";

export function YamlTool() {
  const [input, setInput] = useState("");
  const [indent, setIndent] = useState(2);
  const [sortKeys, setSortKeys] = useState(false);
  const [toJson, setToJson] = useState(false);

  const result = useMemo(() => {
    if (!input.trim()) return { ok: true as const, output: "" };
    return formatYaml(input, { indent, sortKeys, toJson });
  }, [input, indent, sortKeys, toJson]);

  const err = result.ok ? undefined : (result as { error?: string; errorLine?: number; errorCol?: number });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1 text-xs text-gray-500">
            indent
            <select className={`${FIELD_CLASS} w-16 py-1`} value={indent} onChange={(e) => setIndent(Number(e.target.value))}>
              <option value={2}>2</option>
              <option value={4}>4</option>
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs text-gray-500">
            <input type="checkbox" checked={sortKeys} onChange={(e) => setSortKeys(e.target.checked)} /> sort keys
          </label>
          <label className="flex items-center gap-1 text-xs text-gray-500">
            <input type="checkbox" checked={toJson} onChange={(e) => setToJson(e.target.checked)} /> → JSON
          </label>
        </div>
        <Field label="Input">
          <textarea
            className={`${TOOL_TEXTAREA_CLASS} h-80`}
            placeholder={"name: rubato\nfeatures:\n  - tools\n  - services"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
          />
        </Field>
      </div>

      <div className="space-y-2">
        <ErrorNote message={err?.error} line={err?.errorLine} col={err?.errorCol} />
        <OutputBox title={toJson ? "JSON" : "YAML"} text={result.ok ? result.output : ""} />
      </div>
    </div>
  );
}
