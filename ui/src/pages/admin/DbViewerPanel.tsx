import { useQuery } from "@tanstack/react-query";
import { fetchDbStats, fetchDbTables, queryDbTable } from "../../api";
import { CARD_CLASS } from "../../components";
import { fmtBytes } from "./format";
import { TableQueryExplorer } from "./TableQueryExplorer";

/** Read-only viewer of the live rubato SQLite DB: per-table stats + a row browser. */
export function DbViewerPanel() {
  const { data: stats } = useQuery({ queryKey: ["db-stats"], queryFn: fetchDbStats });
  const { data: tables = [] } = useQuery({ queryKey: ["db-tables"], queryFn: fetchDbTables });

  return (
    <div className="space-y-4">
      <div className={`${CARD_CLASS} p-3`}>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-medium">Tables</span>
          {stats && <span className="text-xs text-gray-400">DB file {fmtBytes(stats.dbFileBytes)}</span>}
        </div>
        <div className="max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-100 dark:bg-gray-800">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Table</th>
                <th className="px-2 py-1.5 text-right font-medium">Rows</th>
                <th className="px-2 py-1.5 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {(stats?.tables ?? []).map((t) => (
                <tr key={t.name} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="px-2 py-1 font-mono">{t.name}</td>
                  <td className="px-2 py-1 text-right">{t.rowCount}</td>
                  <td className="px-2 py-1 text-right text-gray-400">{fmtBytes(t.sizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`${CARD_CLASS} p-3`}>
        <p className="mb-2 text-xs text-gray-500">Browse + filter live rows (read-only).</p>
        <TableQueryExplorer tables={tables} runQuery={queryDbTable} />
      </div>
    </div>
  );
}
