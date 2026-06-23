import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyButton } from "cursedbelt/react";
import {
  buildMongoFind,
  COMPARISON_OPS,
  type ComparisonOp,
  type Condition,
  NULLARY_OPS,
  type SqlDialect,
  toInlineSql,
  toMongoShell,
} from "cwip/query";
import { useEffect, useMemo, useState } from "react";
import {
  type DbConnectionInput,
  type DbConnectionWithStatus,
  deleteDbConnection,
  deleteSavedDbQuery,
  fetchDbConnections,
  fetchSavedDbQueries,
  type MongoRunBody,
  QUERY_DIALECTS,
  type RunQueryResult,
  runDbQuery,
  type SavedDbQuery,
  saveDbConnection,
  saveSavedDbQuery,
  type SqlRunBody,
} from "../api";
import { Alert, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, InfoHint, OpenPathButton, PageHeading, PathRef, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { ResultView } from "../result/ResultView";
import { tableFromRecords } from "../result/table";

/**
 * Queries — build SQL (postgres/mysql/mssql) and MongoDB queries against saved
 * connections, save them, and run them when the server has credentials for the
 * connection (QB_<KEY>_* in the environment or ~/.rubato/.env). Construction is
 * cwip/query (in-browser preview); execution is cwip/dbquery on the server.
 * Ported from cursedalchemy's query builder.
 */

// "123" → 123, "true"/"false" → boolean, "null" → null, else the trimmed string.
const coerce = (raw: string): unknown => {
  const s = raw.trim();
  if (s === "") return "";
  if (s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
};

interface WhereRow {
  column: string;
  op: ComparisonOp;
  value: string;
}

const toCondition = (r: WhereRow): Condition => {
  if (NULLARY_OPS.includes(r.op)) return { column: r.column, op: r.op };
  if (r.op === "in" || r.op === "not in" || r.op === "between") {
    return { column: r.column, op: r.op, value: r.value.split(",").map((v) => coerce(v)) };
  }
  return { column: r.column, op: r.op, value: coerce(r.value) };
};

const splitList = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function QueriesPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const connectionsQuery = useQuery({ queryKey: ["db-connections"], queryFn: fetchDbConnections });
  const savedQuery = useQuery({ queryKey: ["db-queries"], queryFn: fetchSavedDbQueries });
  const connections = connectionsQuery.data ?? [];
  const savedQueries = savedQuery.data ?? [];

  const [connId, setConnId] = useState("");
  const [editingConn, setEditingConn] = useState(false);
  const conn = connections.find((c) => c.id === connId);
  const dialect = conn?.dialect ?? "postgres";
  const isMongo = dialect === "mongodb";

  // Shared structured builder state.
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState(""); // comma list (SQL) / projection includes (mongo)
  const [where, setWhere] = useState<WhereRow[]>([]);
  const [orderColumn, setOrderColumn] = useState("");
  const [orderDir, setOrderDir] = useState<"asc" | "desc">("asc");
  const [limit, setLimit] = useState("100");
  const [sqlText, setSqlText] = useState("");
  const [result, setResult] = useState<RunQueryResult | null>(null);
  const [saveName, setSaveName] = useState("");
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  // Default-select the first connection once loaded.
  useEffect(() => {
    if (!connId && connections.length) setConnId(connections[0].id);
  }, [connId, connections]);

  const conditions = useMemo(() => where.filter((w) => w.column).map(toCondition), [where]);
  const limitNum = useMemo(() => {
    const n = Number.parseInt(limit, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, [limit]);

  const sqlSpec = useMemo(
    () => ({
      table,
      columns: splitList(columns),
      where: conditions,
      orderBy: orderColumn ? [{ column: orderColumn, direction: orderDir }] : [],
      limit: limitNum,
    }),
    [table, columns, conditions, orderColumn, orderDir, limitNum],
  );

  const mongoPreview = useMemo(() => {
    if (!isMongo) return "";
    try {
      return toMongoShell({
        collection: table,
        conditions,
        sort: orderColumn ? { [orderColumn]: orderDir === "desc" ? -1 : 1 } : undefined,
        limit: limitNum,
        projection: splitList(columns).reduce<Record<string, 1>>((acc, c) => {
          acc[c] = 1;
          return acc;
        }, {}),
      });
    } catch {
      return "";
    }
  }, [isMongo, table, conditions, orderColumn, orderDir, limitNum, columns]);

  const run = useMutation({
    mutationFn: (body: SqlRunBody | MongoRunBody) => runDbQuery(connId, body),
    onSuccess: setResult,
  });
  const saveQueryMutation = useMutation({
    mutationFn: saveSavedDbQuery,
    onSuccess: (saved) => {
      setLoadedId(saved.id);
      qc.invalidateQueries({ queryKey: ["db-queries"] });
    },
  });
  const removeQueryMutation = useMutation({
    mutationFn: deleteSavedDbQuery,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["db-queries"] }),
  });

  const buildFromForm = () => {
    if (!table) {
      setNotice("Pick or enter a table first");
      return;
    }
    setNotice("");
    setSqlText(toInlineSql(sqlSpec, dialect as SqlDialect));
  };

  const addWhere = () => setWhere((w) => [...w, { column: "", op: "=", value: "" }]);
  const setRow = (i: number, patch: Partial<WhereRow>) =>
    setWhere((w) => w.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setWhere((w) => w.filter((_, idx) => idx !== i));

  const onRun = () => {
    if (!conn) return;
    setResult(null);
    if (isMongo) {
      const { filter, options } = buildMongoFind({
        collection: table,
        conditions,
        sort: orderColumn ? { [orderColumn]: orderDir === "desc" ? -1 : 1 } : undefined,
      });
      const projection = splitList(columns).reduce<Record<string, 1>>((acc, c) => {
        acc[c] = 1;
        return acc;
      }, {});
      run.mutate({
        collection: table,
        filter,
        sort: options.sort,
        projection: Object.keys(projection).length ? projection : undefined,
        limit: limitNum,
      });
    } else {
      run.mutate({ query: sqlText, limit: limitNum });
    }
  };

  const onSave = () => {
    if (!saveName.trim()) {
      setNotice("Name your query first");
      return;
    }
    setNotice("");
    saveQueryMutation.mutate({
      id: loadedId ?? undefined,
      name: saveName.trim(),
      connectionId: conn?.id ?? null,
      dialect,
      kind: isMongo ? "mongo" : "sql",
      collection: table,
      spec: { table, columns, where, orderColumn, orderDir, limit },
      queryText: isMongo ? mongoPreview : sqlText,
    });
  };

  const loadSaved = (q: SavedDbQuery) => {
    const s = (q.spec ?? {}) as Record<string, any>;
    if (q.connectionId) setConnId(q.connectionId);
    setTable(s.table ?? q.collection ?? "");
    setColumns(s.columns ?? "");
    setWhere(Array.isArray(s.where) ? s.where : []);
    setOrderColumn(s.orderColumn ?? "");
    setOrderDir(s.orderDir === "desc" ? "desc" : "asc");
    setLimit(s.limit ?? "100");
    setSqlText(q.kind === "sql" ? q.queryText : "");
    setSaveName(q.name);
    setLoadedId(q.id);
    setResult(null);
  };

  const canRun = Boolean(conn?.hasCredentials) && Boolean(table) && (isMongo || sqlText.trim().length > 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeading title="Queries" />
      <p className="-mt-2 text-sm text-gray-500">
        Build SQL (postgres/mysql/mssql) and MongoDB queries, save them, and — when the server has credentials for
        the connection — run them. Connections never store a password: set QB_&lt;KEY&gt;_PASSWORD (or _URL) in the
        environment or ~/.rubato/.env <OpenPathButton path="~/.rubato/.env" />.
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        {/* Sidebar: connection + saved queries */}
        <div className="flex flex-col gap-4">
          <div className={`${CARD_CLASS} flex flex-col gap-3 p-4`}>
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Connection</h2>
              <Tooltip multiline content="Add a new database connection — a saved target (dialect, host, database, env key) you can build and run queries against. No password is stored: it's resolved from QB_<KEY>_PASSWORD/_URL in the environment. (Or edit/close the form for the selected one.)">
                <button type="button" className={BTN_GHOST_CLASS} onClick={() => setEditingConn((v) => !v)}>
                  {editingConn ? "Close" : conn ? "Edit" : "+ New"}
                </button>
              </Tooltip>
            </div>
            <select className={FIELD_CLASS} value={connId} onChange={(e) => setConnId(e.target.value)}>
              <option value="">— select —</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.dialect})
                </option>
              ))}
            </select>
            {conn && (
              <p
                className={`flex flex-wrap items-center gap-1 text-xs ${
                  conn.hasCredentials ? "text-emerald-600" : "text-amber-600"
                }`}
              >
                {conn.hasCredentials ? (
                  "✓ credentials present — can run"
                ) : (
                  <>
                    ⚠ no creds — set <code className="font-mono">{conn.expectedEnv[0]}</code> in{" "}
                    <PathRef path="~/.rubato/.env" /> to run
                  </>
                )}
              </p>
            )}
            {editingConn && (
              <ConnectionForm
                key={conn?.id ?? "new"}
                connection={conn}
                onSaved={(id) => {
                  setConnId(id);
                  setEditingConn(false);
                  qc.invalidateQueries({ queryKey: ["db-connections"] });
                }}
                onDeleted={() => {
                  setConnId("");
                  setEditingConn(false);
                  qc.invalidateQueries({ queryKey: ["db-connections"] });
                }}
              />
            )}
          </div>

          <div className={`${CARD_CLASS} flex flex-col gap-2 p-4`}>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Saved queries</h2>
            {savedQueries.length === 0 ? (
              <p className="text-xs text-gray-500">None yet.</p>
            ) : (
              savedQueries.map((q) => (
                <div key={q.id} className="flex items-center justify-between gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => loadSaved(q)}
                    className="truncate text-left text-accent hover:underline"
                  >
                    {q.name} <span className="text-xs text-gray-400">({q.dialect})</span>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (await confirm({ prompt: "Delete this saved query?", confirmText: "Delete" }))
                        removeQueryMutation.mutate(q.id);
                    }}
                    className="shrink-0 text-xs text-gray-400 hover:text-rose-600"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Main: builder + editor + results */}
        <div className="flex flex-col gap-4">
          {connections.length === 0 ? (
            <div className={`${CARD_CLASS} p-6 text-sm text-gray-500`}>
              No connections yet — add one to start building queries.
            </div>
          ) : (
            <>
              <div className={`${CARD_CLASS} flex flex-col gap-3 p-4`}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={isMongo ? "Collection" : "Table"}>
                    <input
                      className={FIELD_CLASS}
                      value={table}
                      onChange={(e) => setTable(e.target.value)}
                      placeholder="name"
                    />
                    {(conn?.collections?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {conn?.collections.map((o) => (
                          <button
                            key={o}
                            type="button"
                            onClick={() => setTable(o)}
                            className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300"
                          >
                            {o}
                          </button>
                        ))}
                      </div>
                    )}
                  </Field>
                  <Field label={isMongo ? "Fields (projection, comma)" : "Columns (comma, blank = *)"}>
                    <input
                      className={FIELD_CLASS}
                      value={columns}
                      onChange={(e) => setColumns(e.target.value)}
                      placeholder="id, name"
                    />
                  </Field>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-xs font-medium text-gray-500">
                      Where
                      <InfoHint title="Where conditions">
                        Each row is one filter (column · operator · value), AND-ed together. Operators like "in" and
                        "between" take a comma-separated value list; "is null"/"is not null" take no value. Values are
                        coerced — numbers, true/false, and null are detected automatically.
                      </InfoHint>
                    </span>
                    <button type="button" className={BTN_GHOST_CLASS} onClick={addWhere}>
                      + condition
                    </button>
                  </div>
                  {where.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional + editable
                    <div key={i} className="grid grid-cols-[1fr_130px_1fr_auto] items-center gap-2">
                      <input
                        className={FIELD_CLASS}
                        value={row.column}
                        onChange={(e) => setRow(i, { column: e.target.value })}
                        placeholder="column"
                      />
                      <select
                        className={FIELD_CLASS}
                        value={row.op}
                        onChange={(e) => setRow(i, { op: e.target.value as ComparisonOp })}
                      >
                        {COMPARISON_OPS.map((op) => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </select>
                      {NULLARY_OPS.includes(row.op) ? (
                        <span className="px-2 text-xs italic text-gray-400">(no value)</span>
                      ) : (
                        <input
                          className={FIELD_CLASS}
                          value={row.value}
                          onChange={(e) => setRow(i, { value: e.target.value })}
                          placeholder={row.op === "in" || row.op === "between" ? "comma,separated" : "value"}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => removeRow(i)}
                        className="px-2 text-gray-400 hover:text-rose-600"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Order by">
                    <input
                      className={FIELD_CLASS}
                      value={orderColumn}
                      onChange={(e) => setOrderColumn(e.target.value)}
                      placeholder="column"
                    />
                  </Field>
                  <Field label="Direction">
                    <select
                      className={FIELD_CLASS}
                      value={orderDir}
                      onChange={(e) => setOrderDir(e.target.value as "asc" | "desc")}
                    >
                      <option value="asc">ASC</option>
                      <option value="desc">DESC</option>
                    </select>
                  </Field>
                  <Field label="Limit">
                    <input
                      className={FIELD_CLASS}
                      type="number"
                      value={limit}
                      onChange={(e) => setLimit(e.target.value)}
                    />
                  </Field>
                </div>

                {!isMongo && (
                  <Tooltip multiline content="Generates SQL from the table, columns, where, order, and limit fields above and drops it into the editor below — overwriting what's there. You can then tweak the SQL by hand before running.">
                    <button type="button" className={BTN_GHOST_CLASS} onClick={buildFromForm}>
                      ↻ Build SQL from form
                    </button>
                  </Tooltip>
                )}
              </div>

              {/* Query editor (SQL) / preview (mongo) */}
              <div className={`${CARD_CLASS} flex flex-col gap-2 p-4`}>
                <span className="text-xs font-medium text-gray-500">
                  {isMongo ? "Generated query (mongosh)" : "SQL (editable — this is what runs)"}
                </span>
                {isMongo ? (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-gray-900 p-3 font-mono text-xs text-gray-100">
                    {mongoPreview || "—"}
                  </pre>
                ) : (
                  <textarea
                    className={`${FIELD_CLASS} min-h-32 font-mono`}
                    value={sqlText}
                    onChange={(e) => setSqlText(e.target.value)}
                    placeholder='SELECT … (use "Build SQL from form" or type your own)'
                  />
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={BTN_PRIMARY_CLASS}
                    onClick={onRun}
                    disabled={!canRun || run.isPending}
                  >
                    {run.isPending ? "Running…" : "Run"}
                  </button>
                  <CopyButton
                    value={isMongo ? mongoPreview : sqlText}
                    className={BTN_GHOST_CLASS}
                    tooltip={
                      isMongo
                        ? "Copies the generated mongosh query to your clipboard so you can paste it into a shell or another tool."
                        : "Copies the SQL in the editor to your clipboard so you can paste it into a database client or another tool."
                    }
                  >
                    Copy
                  </CopyButton>
                  <div className="ml-auto flex items-center gap-2">
                    <input
                      className={FIELD_CLASS}
                      value={saveName}
                      onChange={(e) => setSaveName(e.target.value)}
                      placeholder="query name"
                    />
                    <button type="button" className={BTN_GHOST_CLASS} onClick={onSave}>
                      {loadedId ? "Update" : "Save"}
                    </button>
                  </div>
                </div>
                {notice && <p className="text-xs text-amber-600">{notice}</p>}
              </div>

              {result && <RunResultView result={result} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-xs font-medium text-gray-500">
      <span>{label}</span>
      {children}
    </div>
  );
}

function RunResultView({ result }: { result: RunQueryResult }) {
  if (!result.ok) {
    return (
      <Alert tone="error" title="Query failed">
        <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{result.error.message}</pre>
      </Alert>
    );
  }
  return (
    <div className={`${CARD_CLASS} flex flex-col gap-2 p-4`}>
      <p className="text-xs text-gray-500">
        {result.rowCount} row(s){result.truncated ? " (truncated)" : ""} · {result.durationMs}ms
      </p>
      <ResultView
        json={result.rows}
        table={tableFromRecords(result.rows, result.columns)}
        filename="query-result"
        count={result.rowCount}
      />
    </div>
  );
}

function ConnectionForm({
  connection,
  onSaved,
  onDeleted,
}: {
  connection?: DbConnectionWithStatus;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const [form, setForm] = useState<DbConnectionInput>({
    name: connection?.name ?? "",
    dialect: connection?.dialect ?? "postgres",
    host: connection?.host ?? "",
    port: connection?.port ?? null,
    database: connection?.database ?? "",
    username: connection?.username ?? "",
    ssl: connection?.ssl ?? false,
    envKey: connection?.envKey ?? "",
    collections: connection?.collections ?? [],
    allowWrites: connection?.allowWrites ?? false,
  });
  const set = (patch: Partial<DbConnectionInput>) => setForm((f) => ({ ...f, ...patch }));

  // Name the exact env var live as the key is typed — mirrors cwip/dbquery's
  // credentialEnvPrefix (inlined as one line so the UI bundle stays off
  // cwip/dbquery's driver code, which only cwip/query is browser-safe of).
  const envName = form.envKey.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const passwordVar = envName ? `QB_${envName}_PASSWORD` : "QB_<KEY>_PASSWORD";

  const save = async () => {
    const saved = await saveDbConnection({ ...form, id: connection?.id });
    onSaved(saved.id);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
      <input
        className={FIELD_CLASS}
        value={form.name}
        onChange={(e) => set({ name: e.target.value })}
        placeholder="name"
      />
      <select
        className={FIELD_CLASS}
        value={form.dialect}
        onChange={(e) => set({ dialect: e.target.value as DbConnectionInput["dialect"] })}
      >
        {QUERY_DIALECTS.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <input
        className={FIELD_CLASS}
        value={form.host}
        onChange={(e) => set({ host: e.target.value })}
        placeholder="host"
      />
      <input
        className={FIELD_CLASS}
        type="number"
        value={form.port == null ? "" : String(form.port)}
        onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : null })}
        placeholder="port"
      />
      <input
        className={FIELD_CLASS}
        value={form.database}
        onChange={(e) => set({ database: e.target.value })}
        placeholder="database"
      />
      <input
        className={FIELD_CLASS}
        value={form.username}
        onChange={(e) => set({ username: e.target.value })}
        placeholder="username"
      />
      <input
        className={FIELD_CLASS}
        value={form.envKey}
        onChange={(e) => set({ envKey: e.target.value })}
        placeholder="env key (→ QB_<KEY>_PASSWORD)"
      />
      <p className="-mt-1 flex flex-wrap items-center gap-1 text-xs text-gray-500">
        Passwords are never stored here — set <code className="font-mono">{passwordVar}</code> (or{" "}
        <code className="font-mono">_URL</code>) in <PathRef path="~/.rubato/.env" />.
      </p>
      <input
        className={FIELD_CLASS}
        value={form.collections.join(", ")}
        onChange={(e) =>
          set({
            collections: e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
        placeholder="tables/collections (comma)"
      />
      <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
        <input type="checkbox" checked={form.ssl} onChange={(e) => set({ ssl: e.target.checked })} /> SSL
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
        <input type="checkbox" checked={form.allowWrites} onChange={(e) => set({ allowWrites: e.target.checked })} />
        Allow writes (also needs QB_ALLOW_WRITES on the server)
      </label>
      <div className="flex items-center gap-2">
        <button type="button" className={BTN_PRIMARY_CLASS} onClick={save} disabled={!form.name}>
          Save
        </button>
        {connection && (
          <button
            type="button"
            className={BTN_GHOST_CLASS}
            onClick={async () => {
              if (await confirm({ prompt: "Delete this connection?", confirmText: "Delete" })) {
                await deleteDbConnection(connection.id);
                onDeleted();
              }
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
