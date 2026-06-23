import { dataToTypeScript } from "@shared/resultTypes";
import { CopyButton } from "cursedbelt/react";
import { useMemo } from "react";
import { Tooltip } from "../components";
import { downloadText } from "./download";

/**
 * The **TS** result view: auto-generate a TypeScript declaration from the result
 * data (cwip/shape, via `@shared/resultTypes`) and show it with copy + `.ts`
 * download. Shared by `ResultView` and the admin DB viewer's `DataResultsTable`,
 * so "make types from this live data" works the same everywhere a result renders.
 */
export function TypesView({
  data,
  typeName = "Result",
  filename = "result",
  maxHeight = "28rem",
}: {
  /** The result value to infer a type from (an array of rows, or any JSON value). */
  data: unknown;
  /** Base name for the generated type (sanitized to PascalCase). */
  typeName?: string;
  /** Base name for the `.ts` download (no extension). */
  filename?: string;
  maxHeight?: string;
}) {
  const ts = useMemo(() => dataToTypeScript(data, typeName), [data, typeName]);

  return (
    <div className="p-2">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="text-gray-400">Inferred from the result data</span>
        <div className="ml-auto flex items-center gap-2">
          <CopyButton
            value={ts}
            showIcon={false}
            tooltip="Copy the TypeScript to the clipboard"
            copiedText="Copied ✓"
            className="text-gray-500 hover:text-accent"
          >
            Copy
          </CopyButton>
          <Tooltip content="Download as a .ts file">
            <button
              type="button"
              onClick={() => downloadText(`${filename}.ts`, ts, "text/plain")}
              className="text-gray-500 hover:text-accent"
            >
              .ts ↓
            </button>
          </Tooltip>
        </div>
      </div>
      <pre
        className="overflow-auto rounded bg-gray-50 p-3 font-mono text-xs text-gray-800 dark:bg-gray-900/60 dark:text-gray-200"
        style={{ maxHeight }}
      >
        {ts}
      </pre>
    </div>
  );
}
