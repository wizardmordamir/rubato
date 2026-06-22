import { csvToJson, jsonToCsv } from "@shared/tools/json";
import { JsonEditor } from "cursedbelt/react";
import { useMemo, useState } from "react";
import { FIELD_CLASS } from "../../components";
import { ErrorNote, Field, OutputBox, TOOL_TEXTAREA_CLASS } from "./toolkit";

type Mode = "format" | "csvToJson" | "jsonToCsv";

const PLACEHOLDER: Record<Mode, string> = {
  format: "{ a: 1, b: 'two', /* loose JS is ok */ }",
  csvToJson: "name,age\nAda,36\nGrace,45",
  jsonToCsv: '[{ "name": "Ada", "age": 36 }]',
};

export function JsonTool() {
  const [mode, setMode] = useState<Mode>("format");
  const [input, setInput] = useState("");
  const [indent, setIndent] = useState(2);
  const [delimiter, setDelimiter] = useState(",");
  const [hasHeader, setHasHeader] = useState(true);

  // CSV conversions stay two-pane (input → output, different shapes); the "format"
  // mode is an in-place edit via the shared cwip <JsonEditor>.
  const result = useMemo(() => {
    if (mode === "format" || !input.trim()) return { ok: true as const, output: "" };
    if (mode === "csvToJson") return csvToJson(input, { delimiter, hasHeader, indent });
    return jsonToCsv(input, { delimiter });
  }, [mode, input, indent, delimiter, hasHeader]);

  const err = result.ok ? undefined : (result as { error?: string; errorLine?: number; errorCol?: number });

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <select className={`${FIELD_CLASS} w-44`} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
        <option value="format">Format JSON</option>
        <option value="csvToJson">CSV → JSON</option>
        <option value="jsonToCsv">JSON → CSV</option>
      </select>
      {mode === "csvToJson" && (
        <label className="flex items-center gap-1 text-xs text-gray-500">
          indent
          <select
            className={`${FIELD_CLASS} w-16 py-1`}
            value={indent}
            onChange={(e) => setIndent(Number(e.target.value))}
          >
            <option value={2}>2</option>
            <option value={4}>4</option>
          </select>
        </label>
      )}
      {mode !== "format" && (
        <label className="flex items-center gap-1 text-xs text-gray-500">
          delimiter
          <input
            className={`${FIELD_CLASS} w-12 py-1`}
            value={delimiter}
            onChange={(e) => setDelimiter(e.target.value || ",")}
          />
        </label>
      )}
      {mode === "csvToJson" && (
        <label className="flex items-center gap-1 text-xs text-gray-500">
          <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> header row
        </label>
      )}
    </div>
  );

  // Format mode: a single in-place editor (paste loose JS/JSON, click Format).
  if (mode === "format") {
    return (
      <div className="space-y-3">
        {controls}
        <JsonEditor value={input} onChange={setInput} placeholder={PLACEHOLDER.format} rows={18} formatLabel="Format" />
      </div>
    );
  }

  // CSV conversions: input on the left, converted output on the right.
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        {controls}
        <Field label="Input">
          <textarea
            className={`${TOOL_TEXTAREA_CLASS} h-80`}
            placeholder={PLACEHOLDER[mode]}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
          />
        </Field>
      </div>

      <div className="space-y-2">
        <ErrorNote message={err?.error} line={err?.errorLine} col={err?.errorCol} />
        <OutputBox title="Output" text={result.ok ? result.output : ""} />
      </div>
    </div>
  );
}
