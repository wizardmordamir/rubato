import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

/** Pretty-print JSON when it parses; otherwise hand back the raw text unchanged. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * Parse RFC-4180 CSV (the shape `toCsv` emits — quoted fields, doubled quotes,
 * embedded commas/newlines) into rows of cells. Returns null on anything that
 * doesn't look like a grid, so the caller can fall back to raw text.
 */
function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const grid = rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  return grid.length ? grid : null;
}

/** A read-only table for a parsed report CSV (header row + body). */
function CsvTable({ grid }: { grid: string[][] }) {
  const [head, ...body] = grid;
  return (
    <div className="overflow-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-gray-100 dark:bg-gray-800/60">
            {head.map((h, i) => (
              <th
                key={`${h}-${i}`}
                className="border-b border-gray-200 px-2 py-1 text-left font-medium dark:border-gray-700"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className="odd:bg-gray-50/60 dark:odd:bg-gray-800/30">
              {head.map((_, ci) => (
                <td key={ci} className="border-b border-gray-100 px-2 py-1 font-mono dark:border-gray-800">
                  {r[ci] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Render one script-output file's text, picking a presentation from its name:
 * `.md` → rendered markdown, `.json` → pretty-printed, `.csv` → a table (so a
 * report reads like a report), everything else → a monospace block (the common
 * case — `<command>.txt` captures, lists).
 */
export function FileViewer({ name, content }: { name: string; content: string }) {
  const ext = name.toLowerCase().split(".").pop();

  if (ext === "md") {
    return (
      <article className="chat-md min-w-0 dark:text-gray-300">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {content}
        </ReactMarkdown>
      </article>
    );
  }

  if (ext === "csv") {
    const grid = parseCsv(content);
    if (grid) return <CsvTable grid={grid} />;
  }

  const body = ext === "json" ? prettyJson(content) : content;
  return (
    <pre className="overflow-auto rounded-lg bg-gray-100 p-3 font-mono text-xs whitespace-pre-wrap dark:bg-gray-800/60">
      {body}
    </pre>
  );
}
