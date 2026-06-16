import { useState } from "react";
import type { QueryFilter, QueryRequest, QueryResult, TableInfo } from "../../api";
import { Alert, FIELD_CLASS } from "../../components";
import { DataResultsTable } from "./DataResultsTable";
import { FilterBuilder } from "./FilterBuilder";

const PAGE = 100;

/**
 * Reusable table browser: pick a table, build filters, page through rows. The
 * caller supplies `runQuery` so the same component drives both the live DB and a
 * backup file (different endpoints, identical UI).
 */
export function TableQueryExplorer({
  tables,
  runQuery,
}: {
  tables: TableInfo[];
  runQuery: (table: string, body: QueryRequest) => Promise<QueryResult>;
}) {
  const [table, setTable] = useState("");
  const [filters, setFilters] = useState<QueryFilter[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (t: string, nextFilters: QueryFilter[], offset: number) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await runQuery(t, { filters: nextFilters, limit: PAGE, offset }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "query failed");
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const pick = (t: string) => {
    setTable(t);
    setFilters([]);
    if (t) run(t, [], 0);
    else setResult(null);
  };

  const apply = (f: QueryFilter[]) => {
    setFilters(f);
    if (table) run(table, f, 0);
  };

  return (
    <div className="space-y-3">
      <select value={table} onChange={(e) => pick(e.target.value)} className={`${FIELD_CLASS} w-auto py-1.5`}>
        <option value="">select a table…</option>
        {tables.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name} ({t.rowCount})
          </option>
        ))}
      </select>

      {result && <FilterBuilder columns={result.columns} onApply={apply} />}
      {error && (
        <Alert tone="error" size="sm">
          {error}
        </Alert>
      )}
      {busy && !result && <p className="text-gray-400">loading…</p>}
      {result && <DataResultsTable result={result} onPage={(offset) => run(table, filters, offset)} />}
    </div>
  );
}
