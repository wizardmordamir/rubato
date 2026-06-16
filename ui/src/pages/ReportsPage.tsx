import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchFileContent, fetchFiles, fileDownloadUrl } from "../api";
import { CARD_CLASS, OpenPathButton, PageHeading, SearchInput, Tooltip } from "../components";
import { FileViewer } from "./FileViewer";

/** "1.4 KB", "820 B", "2.1 MB" — compact human size. */
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function when(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleString();
}

export function ReportsPage() {
  // Poll so files written by a fresh run (web or terminal) show up on their own.
  const { data: files = [] } = useQuery({ queryKey: ["files"], queryFn: fetchFiles, refetchInterval: 4000 });
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const shown = filter.trim()
    ? files.filter((f) => f.path.toLowerCase().includes(filter.trim().toLowerCase()))
    : files;

  const { data: viewing, isLoading } = useQuery({
    queryKey: ["file", selected],
    queryFn: () => fetchFileContent(selected as string),
    enabled: selected !== null,
  });

  return (
    <div>
      <PageHeading title="Output Files" count={files.length} />
      <p className="mb-3 text-xs text-gray-400">
        Files under your output dir, read-only: per-command <code>.txt</code> captures plus the structured{" "}
        <code>&lt;command&gt;.report.json</code> / <code>.report.csv</code> data reports the info commands
        (findchanges, appstatus, appall, …) write — summary stats + a row per app/branch/entry.
      </p>
      {files.length === 0 ? (
        <p className="text-gray-400">
          No output files yet — run a command (e.g. <code>findchanges</code>) and its capture + report land here.
        </p>
      ) : (
        <div className="flex gap-6">
          <nav className="flex w-64 shrink-0 flex-col gap-2">
            <SearchInput value={filter} onChange={setFilter} placeholder="filter files…" />
            <ul className="flex flex-col gap-1">
              {shown.map((f) => (
                <li key={f.path} className="flex items-center gap-1">
                  <Tooltip content={f.path} className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => setSelected(f.path)}
                      className={`w-full rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                        f.path === selected
                          ? "bg-accent-soft font-medium text-accent"
                          : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                      }`}
                    >
                      <span className="block truncate font-mono text-xs">{f.path}</span>
                      <span className="block text-[11px] text-gray-400">
                        {bytes(f.size)} · {when(f.modifiedAt)}
                      </span>
                    </button>
                  </Tooltip>
                  <OpenPathButton path={f.path} />
                </li>
              ))}
              {shown.length === 0 && <li className="px-3 py-1.5 text-xs text-gray-400">no match</li>}
            </ul>
          </nav>
          <section className="min-w-0 flex-1">
            {selected === null ? (
              <p className="text-gray-400">Select a file to view it.</p>
            ) : (
              <div className={`${CARD_CLASS} p-4`}>
                <div className="mb-3 flex items-baseline gap-2">
                  <span className="font-mono text-sm font-medium">{selected}</span>
                  {viewing && <span className="text-xs text-gray-400">{bytes(viewing.file.size)}</span>}
                  <a
                    href={fileDownloadUrl(selected)}
                    download
                    className="ml-auto text-xs text-accent hover:underline"
                  >
                    ↓ Download
                  </a>
                  <OpenPathButton path={selected} />
                </div>
                {isLoading ? <p className="text-gray-400">loading…</p> : <FileViewer name={selected} content={viewing?.content ?? ""} />}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
