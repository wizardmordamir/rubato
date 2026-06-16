import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  deleteSnConnection,
  deleteSnRequest,
  fetchSnConnections,
  fetchSnRequests,
  runSnRequest,
  saveSnConnection,
  saveSnRequest,
  type SnConnectionInput,
  type SnConnectionWithStatus,
  type SnHttpMethod,
  type SnOperation,
  type SnRunBody,
  type SnRunResult,
  type SnSavedRequest,
} from "../api";
import { Alert, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, OpenPathButton, PageHeading, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { ResultView } from "../result/ResultView";
import { tableFromRecords } from "../result/table";

/**
 * ServiceNow — read/update records via the Table API, or call any endpoint
 * (passthrough), against saved connections. Connections never store a secret; the
 * server resolves a token/password from the environment (SN_<KEY>_* in process.env
 * or ~/.rubato/.env). The REST client lives in cwip/servicenow (shared with
 * cursedalchemy); writes need allowWrites AND SN_ALLOW_WRITES=true.
 */

const OPERATIONS: { value: SnOperation; label: string }[] = [
  { value: "table_read", label: "Table — read" },
  { value: "table_write", label: "Table — write" },
  { value: "passthrough", label: "Passthrough (any endpoint)" },
];
const METHODS: SnHttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const emptyConnection = (): SnConnectionInput => ({
  name: "",
  instanceUrl: "",
  username: "",
  envKey: "",
  defaultTable: "incident",
  allowWrites: false,
});

export function ServiceNowPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: connections = [] } = useQuery({ queryKey: ["sn-connections"], queryFn: fetchSnConnections });
  const { data: saved = [] } = useQuery({ queryKey: ["sn-requests"], queryFn: fetchSnRequests });

  const [connId, setConnId] = useState("");
  const [editingConn, setEditingConn] = useState(false);
  const conn = connections.find((c) => c.id === connId);

  const [operation, setOperation] = useState<SnOperation>("table_read");
  const [table, setTable] = useState("");
  const [query, setQuery] = useState("");
  const [fields, setFields] = useState("");
  const [limit, setLimit] = useState("100");
  const [displayValue, setDisplayValue] = useState<"true" | "false" | "all">("true");
  const [writeMode, setWriteMode] = useState<"create" | "update">("create");
  const [sysId, setSysId] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [method, setMethod] = useState<SnHttpMethod>("GET");
  const [path, setPath] = useState("");

  const [result, setResult] = useState<SnRunResult | null>(null);
  const [saveName, setSaveName] = useState("");
  const [loadedId, setLoadedId] = useState<string | undefined>();

  // Default-select the first connection; seed the table from its default.
  useEffect(() => {
    if (!connId && connections.length) setConnId(connections[0].id);
  }, [connId, connections]);
  useEffect(() => {
    if (conn && !table) setTable(conn.defaultTable);
  }, [conn, table]);

  const limitNum = useMemo(() => {
    const n = Number.parseInt(limit, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, [limit]);

  const parseBody = (): [unknown, string | null] => {
    if (!bodyText.trim()) return [{}, null];
    try {
      return [JSON.parse(bodyText), null];
    } catch (e) {
      return [null, e instanceof Error ? e.message : "Invalid JSON"];
    }
  };

  const buildRunBody = (): SnRunBody | null => {
    if (operation === "table_read") {
      return {
        operation,
        table: table.trim(),
        query: query.trim() || undefined,
        fields: fields
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean),
        limit: limitNum,
        displayValue,
      };
    }
    if (operation === "table_write") {
      const [body, err] = parseBody();
      if (err) return null;
      return { operation, table: table.trim(), writeMode, sysId: sysId.trim() || undefined, body };
    }
    const [body, err] = parseBody();
    if (err) return null;
    return { operation, method, path: path.trim(), body };
  };

  const run = useMutation({
    mutationFn: () => {
      const body = buildRunBody();
      if (!conn || !body) throw new Error("Body is not valid JSON");
      return runSnRequest(conn.id, body);
    },
    onSuccess: (r) => setResult(r),
    onError: (e) => setResult({ ok: false, error: { code: "client", message: (e as Error).message } }),
  });

  const currentSpec = () => {
    if (operation === "table_read")
      return {
        table,
        query,
        fields: fields
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean),
        limit: limitNum,
        displayValue,
      };
    if (operation === "table_write") return { table, writeMode, sysId, body: bodyText };
    return { method, path, body: bodyText };
  };

  const save = useMutation({
    mutationFn: () =>
      saveSnRequest({
        id: loadedId,
        name: saveName.trim() || "Untitled",
        connectionId: conn?.id ?? null,
        operation,
        spec: currentSpec(),
      }),
    onSuccess: (s) => {
      setLoadedId(s.id);
      setSaveName(s.name);
      qc.invalidateQueries({ queryKey: ["sn-requests"] });
    },
  });

  const removeRequest = useMutation({
    mutationFn: deleteSnRequest,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sn-requests"] }),
  });

  const loadSaved = (r: SnSavedRequest) => {
    const s = (r.spec ?? {}) as Record<string, any>;
    if (r.connectionId) setConnId(r.connectionId);
    setOperation(r.operation);
    setTable(s.table ?? "");
    setQuery(s.query ?? "");
    setFields(Array.isArray(s.fields) ? s.fields.join(", ") : (s.fields ?? ""));
    setLimit(s.limit ? String(s.limit) : "100");
    setDisplayValue(s.displayValue === "false" ? "false" : s.displayValue === "all" ? "all" : "true");
    setWriteMode(s.writeMode === "update" ? "update" : "create");
    setSysId(s.sysId ?? "");
    setMethod(METHODS.includes(s.method) ? s.method : "GET");
    setPath(s.path ?? "");
    setBodyText(typeof s.body === "string" ? s.body : s.body ? JSON.stringify(s.body, null, 2) : "");
    setSaveName(r.name);
    setLoadedId(r.id);
    setResult(null);
  };

  const isWrite = operation === "table_write" || (operation === "passthrough" && method !== "GET");
  const canRun =
    Boolean(conn?.hasCredentials) &&
    (operation === "passthrough" ? path.trim().length > 0 : table.trim().length > 0) &&
    (!isWrite || conn?.allowWrites === true);

  const resultTable = result?.ok ? tableFromRecords(result.rows ?? []) : null;

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto">
      <PageHeading title="ServiceNow" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        {/* Sidebar: connections + saved requests */}
        <div className="flex flex-col gap-4">
          <div className={`${CARD_CLASS} flex flex-col gap-2 p-3`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-gray-500 text-xs uppercase tracking-wide">Connection</span>
              <Tooltip multiline content="Add a new ServiceNow connection — a saved instance (URL, username, default table, env key) you can read/write records and call endpoints against. No secret is stored: a token/password is resolved from SN_<KEY>_* in the environment. (Or edit/close the form for the selected one.)">
                <button type="button" className={BTN_GHOST_CLASS} onClick={() => setEditingConn((v) => !v)}>
                  {editingConn ? "Close" : conn ? "Edit" : "+ New"}
                </button>
              </Tooltip>
            </div>
            <select className={FIELD_CLASS} value={connId} onChange={(e) => setConnId(e.target.value)}>
              <option value="">— select —</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {conn && (
              <p className={`text-xs ${conn.hasCredentials ? "text-emerald-600" : "text-amber-600"}`}>
                {conn.hasCredentials
                  ? `✓ ${conn.authKind} auth — can run`
                  : `⚠ no creds — set ${conn.expectedEnv[0]} (env or ~/.rubato/.env)`}
                {!conn.hasCredentials && <OpenPathButton path="~/.rubato/.env" />}
              </p>
            )}
            {editingConn && (
              <ConnectionForm
                key={conn?.id ?? "new"}
                connection={conn}
                onSaved={(id) => {
                  setConnId(id);
                  setEditingConn(false);
                }}
                onDeleted={() => {
                  setConnId("");
                  setEditingConn(false);
                }}
              />
            )}
          </div>

          <div className={`${CARD_CLASS} flex flex-col gap-2 p-3`}>
            <span className="font-semibold text-gray-500 text-xs uppercase tracking-wide">Saved requests</span>
            {saved.length === 0 ? (
              <p className="text-gray-500 text-xs">None yet.</p>
            ) : (
              saved.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => loadSaved(r)}
                    className="truncate text-left text-accent hover:underline"
                  >
                    {r.name} <span className="text-gray-400 text-xs">({r.operation.replace("_", " ")})</span>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (await confirm({ prompt: "Delete this saved request?", confirmText: "Delete" }))
                        removeRequest.mutate(r.id);
                    }}
                    className="shrink-0 text-gray-400 text-xs hover:text-rose-600"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Main builder + results */}
        <div className="flex flex-col gap-4">
          {connections.length === 0 ? (
            <div className={`${CARD_CLASS} p-6 text-center text-gray-500 text-sm`}>
              No connections yet. Add a ServiceNow connection to start making requests.
            </div>
          ) : (
            <>
              <div className={`${CARD_CLASS} flex flex-col gap-3 p-4`}>
                <Field label="Operation">
                  <select
                    className={FIELD_CLASS}
                    value={operation}
                    onChange={(e) => setOperation(e.target.value as SnOperation)}
                  >
                    {OPERATIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>

                {operation === "table_read" && (
                  <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Table">
                        <input
                          className={FIELD_CLASS}
                          value={table}
                          onChange={(e) => setTable(e.target.value)}
                          placeholder="incident"
                        />
                      </Field>
                      <Field label="Fields (comma, blank = all)">
                        <input
                          className={FIELD_CLASS}
                          value={fields}
                          onChange={(e) => setFields(e.target.value)}
                          placeholder="number, short_description, state"
                        />
                      </Field>
                    </div>
                    <Field label="Encoded query (sysparm_query)">
                      <input
                        className={FIELD_CLASS}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="active=true^priority=1"
                      />
                    </Field>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Limit">
                        <input
                          className={FIELD_CLASS}
                          type="number"
                          value={limit}
                          onChange={(e) => setLimit(e.target.value)}
                        />
                      </Field>
                      <Field label="Display values">
                        <select
                          className={FIELD_CLASS}
                          value={displayValue}
                          onChange={(e) => setDisplayValue(e.target.value as "true" | "false" | "all")}
                        >
                          <option value="true">true (labels)</option>
                          <option value="false">false (raw)</option>
                          <option value="all">all (both)</option>
                        </select>
                      </Field>
                    </div>
                  </>
                )}

                {operation === "table_write" && (
                  <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Mode">
                        <select
                          className={FIELD_CLASS}
                          value={writeMode}
                          onChange={(e) => setWriteMode(e.target.value as "create" | "update")}
                        >
                          <option value="create">Create</option>
                          <option value="update">Update</option>
                        </select>
                      </Field>
                      <Field label="Table">
                        <input
                          className={FIELD_CLASS}
                          value={table}
                          onChange={(e) => setTable(e.target.value)}
                          placeholder="incident"
                        />
                      </Field>
                    </div>
                    {writeMode === "update" && (
                      <Field label="sys_id">
                        <input
                          className={FIELD_CLASS}
                          value={sysId}
                          onChange={(e) => setSysId(e.target.value)}
                          placeholder="record sys_id"
                        />
                      </Field>
                    )}
                    <Field label="Record fields (JSON)">
                      <textarea
                        className={`${FIELD_CLASS} min-h-32 font-mono`}
                        value={bodyText}
                        onChange={(e) => setBodyText(e.target.value)}
                        placeholder={'{\n  "short_description": "…",\n  "urgency": "2"\n}'}
                      />
                    </Field>
                  </>
                )}

                {operation === "passthrough" && (
                  <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr]">
                      <Field label="Method">
                        <select
                          className={FIELD_CLASS}
                          value={method}
                          onChange={(e) => setMethod(e.target.value as SnHttpMethod)}
                        >
                          {METHODS.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Path">
                        <input
                          className={FIELD_CLASS}
                          value={path}
                          onChange={(e) => setPath(e.target.value)}
                          placeholder="/api/now/table/incident"
                        />
                      </Field>
                    </div>
                    {method !== "GET" && method !== "DELETE" && (
                      <Field label="Body (JSON)">
                        <textarea
                          className={`${FIELD_CLASS} min-h-32 font-mono`}
                          value={bodyText}
                          onChange={(e) => setBodyText(e.target.value)}
                          placeholder="{ }"
                        />
                      </Field>
                    )}
                  </>
                )}

                {isWrite && !conn?.allowWrites && (
                  <p className="text-amber-600 text-xs">
                    ⚠ Writes are disabled for this connection. Enable “allow writes” on it (and set
                    SN_ALLOW_WRITES=true on the server).
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={BTN_PRIMARY_CLASS}
                    onClick={() => run.mutate()}
                    disabled={!canRun || run.isPending}
                  >
                    {run.isPending ? "Running…" : "Run"}
                  </button>
                  <div className="ml-auto flex items-center gap-2">
                    <input
                      className={FIELD_CLASS}
                      value={saveName}
                      onChange={(e) => setSaveName(e.target.value)}
                      placeholder="request name"
                    />
                    <Tooltip
                      multiline
                      content="Saves the current operation, connection, and all its inputs as a named, reusable request in the sidebar (it doesn't run it). Once loaded a request was edited, Update overwrites that saved one in place."
                    >
                      <button type="button" className={BTN_GHOST_CLASS} onClick={() => save.mutate()}>
                        {loadedId ? "Update" : "Save"}
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </div>

              {result &&
                (result.ok ? (
                  <ResultView
                    json={result.result ?? {}}
                    table={resultTable}
                    filename="servicenow"
                    count={result.rowCount}
                  />
                ) : (
                  <Alert tone="error" title={`Request failed${result.status ? ` (HTTP ${result.status})` : ""}`}>
                    <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{result.error?.message}</pre>
                  </Alert>
                ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 font-medium text-gray-500 text-xs">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ConnectionForm({
  connection,
  onSaved,
  onDeleted,
}: {
  connection?: SnConnectionWithStatus;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [form, setForm] = useState<SnConnectionInput>({
    name: connection?.name ?? "",
    instanceUrl: connection?.instanceUrl ?? "",
    username: connection?.username ?? "",
    envKey: connection?.envKey ?? "",
    defaultTable: connection?.defaultTable ?? "incident",
    allowWrites: connection?.allowWrites ?? false,
  });
  const set = (patch: Partial<SnConnectionInput>) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () => saveSnConnection({ id: connection?.id, ...form }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["sn-connections"] });
      onSaved(c.id);
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteSnConnection(connection!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sn-connections"] });
      onDeleted();
    },
  });

  return (
    <div className="flex flex-col gap-2 border-gray-200 border-t pt-2 dark:border-gray-800">
      <input
        className={FIELD_CLASS}
        value={form.name}
        onChange={(e) => set({ name: e.target.value })}
        placeholder="name"
      />
      <input
        className={FIELD_CLASS}
        value={form.instanceUrl}
        onChange={(e) => set({ instanceUrl: e.target.value })}
        placeholder="https://dev12345.service-now.com"
      />
      <input
        className={FIELD_CLASS}
        value={form.username}
        onChange={(e) => set({ username: e.target.value })}
        placeholder="username (for basic auth)"
      />
      <input
        className={FIELD_CLASS}
        value={form.envKey}
        onChange={(e) => set({ envKey: e.target.value })}
        placeholder="env key (→ SN_<KEY>_TOKEN / _PASSWORD)"
      />
      <input
        className={FIELD_CLASS}
        value={form.defaultTable}
        onChange={(e) => set({ defaultTable: e.target.value })}
        placeholder="default table (e.g. incident)"
      />
      <label className="flex items-center gap-2 text-gray-600 text-xs dark:text-gray-300">
        <input type="checkbox" checked={form.allowWrites} onChange={(e) => set({ allowWrites: e.target.checked })} />
        Allow writes (also needs SN_ALLOW_WRITES on the server)
      </label>
      <div className="flex items-center gap-2">
        <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => save.mutate()} disabled={!form.name}>
          Save
        </button>
        {connection && (
          <button
            type="button"
            className={`${BTN_GHOST_CLASS} text-rose-600`}
            onClick={async () => {
              if (await confirm({ prompt: "Delete this connection?", confirmText: "Delete" })) remove.mutate();
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
