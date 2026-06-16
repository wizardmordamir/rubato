import { buildCurl, buildFetch, type CurlAuth, type CurlKV, type CurlRequestInput } from "@shared/tools/curl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { deleteSavedCurlRequest, fetchSavedCurlRequests, saveCurlRequest } from "../../api";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, Tooltip } from "../../components";
import { useToast } from "../../toast";
import { Field, OutputBox, SavedList } from "./toolkit";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const FLAGS: Array<[string, string]> = [
  ["-L", "follow redirects"],
  ["-k", "insecure (skip TLS verify)"],
  ["-i", "include response headers"],
  ["-v", "verbose"],
  ["-s", "silent"],
  ["--compressed", "request compression"],
];

const emptyRow = (): CurlKV => ({ key: "", value: "", enabled: true });

/** A compact key/value/enabled row editor (for headers + query params). */
function KVEditor({ rows, onChange }: { rows: CurlKV[]; onChange: (rows: CurlKV[]) => void }) {
  const set = (i: number, patch: Partial<CurlKV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and editable
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => set(i, { enabled: e.target.checked })}
            aria-label="enabled"
          />
          <input className={`${FIELD_CLASS} flex-1 py-1`} placeholder="key" value={r.key} onChange={(e) => set(i, { key: e.target.value })} />
          <input
            className={`${FIELD_CLASS} flex-1 py-1`}
            placeholder="value"
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className={BTN_GHOST_CLASS} onClick={() => onChange([...rows, emptyRow()])}>
        + add
      </button>
    </div>
  );
}

export function CurlTool() {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("https://api.example.com/v1/things");
  const [queryParams, setQueryParams] = useState<CurlKV[]>([]);
  const [headers, setHeaders] = useState<CurlKV[]>([]);
  const [auth, setAuth] = useState<CurlAuth>({ type: "none" });
  const [bodyType, setBodyType] = useState<CurlRequestInput["bodyType"]>("none");
  const [body, setBody] = useState("");
  const [flags, setFlags] = useState<string[]>([]);

  const req: CurlRequestInput = useMemo(
    () => ({ method, url, queryParams, headers, auth, bodyType, body, flags }),
    [method, url, queryParams, headers, auth, bodyType, body, flags],
  );
  const curl = useMemo(() => buildCurl(req), [req]);
  const fetchSnippet = useMemo(() => buildFetch(req), [req]);

  const toggleFlag = (f: string) => setFlags((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));

  // Saved requests.
  const qc = useQueryClient();
  const { notify } = useToast();
  const [name, setName] = useState("");
  const { data: saved = [] } = useQuery({ queryKey: ["saved-curl"], queryFn: fetchSavedCurlRequests });

  const save = useMutation({
    mutationFn: () => saveCurlRequest({ name, request: req }),
    onSuccess: () => {
      setName("");
      notify("Saved", "success");
      qc.invalidateQueries({ queryKey: ["saved-curl"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteSavedCurlRequest(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-curl"] }),
  });

  const load = (r: CurlRequestInput) => {
    setMethod(r.method);
    setUrl(r.url);
    setQueryParams(r.queryParams);
    setHeaders(r.headers);
    setAuth(r.auth);
    setBodyType(r.bodyType);
    setBody(r.body);
    setFlags(r.flags);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="flex gap-2">
          <select className={`${FIELD_CLASS} w-32`} value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input className={FIELD_CLASS} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>

        <Field label="Query params">
          <KVEditor rows={queryParams} onChange={setQueryParams} />
        </Field>

        <Field label="Headers">
          <KVEditor rows={headers} onChange={setHeaders} />
        </Field>

        <Field label="Auth">
          <div className="flex flex-wrap gap-2">
            <select
              className={`${FIELD_CLASS} w-28`}
              value={auth.type}
              onChange={(e) => setAuth({ type: e.target.value as CurlAuth["type"] })}
            >
              <option value="none">none</option>
              <option value="basic">basic</option>
              <option value="bearer">bearer</option>
            </select>
            {auth.type === "basic" && (
              <>
                <input className={`${FIELD_CLASS} flex-1`} placeholder="username" value={auth.username ?? ""} onChange={(e) => setAuth({ ...auth, username: e.target.value })} />
                <input className={`${FIELD_CLASS} flex-1`} placeholder="password" value={auth.password ?? ""} onChange={(e) => setAuth({ ...auth, password: e.target.value })} />
              </>
            )}
            {auth.type === "bearer" && (
              <input className={`${FIELD_CLASS} flex-1`} placeholder="token" value={auth.token ?? ""} onChange={(e) => setAuth({ ...auth, token: e.target.value })} />
            )}
          </div>
        </Field>

        <Field label="Body">
          <select
            className={`${FIELD_CLASS} mb-1.5 w-28`}
            value={bodyType}
            onChange={(e) => setBodyType(e.target.value as CurlRequestInput["bodyType"])}
          >
            <option value="none">none</option>
            <option value="json">json</option>
            <option value="form">form</option>
            <option value="raw">raw</option>
          </select>
          {bodyType !== "none" && (
            <textarea
              className={`${FIELD_CLASS} h-24 font-mono`}
              placeholder={bodyType === "json" ? '{ "a": 1 }' : "a=1&b=2"}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
        </Field>

        <Field label="Flags">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {FLAGS.map(([f, hint]) => (
              <Tooltip key={f} content={hint}>
                <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
                  <input type="checkbox" checked={flags.includes(f)} onChange={() => toggleFlag(f)} />
                  <code>{f}</code>
                </label>
              </Tooltip>
            ))}
          </div>
        </Field>
      </div>

      <div className="space-y-3">
        <OutputBox title="curl" text={curl} />
        <OutputBox title="fetch" text={fetchSnippet} />

        <div className={`${CARD_CLASS} p-3`}>
          <div className="mb-2 text-xs font-medium text-gray-500">Saved requests</div>
          <div className="mb-2 flex gap-1.5">
            <input
              className={`${FIELD_CLASS} flex-1 py-1`}
              placeholder="name this request"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="button"
              className={BTN_PRIMARY_CLASS}
              disabled={!name.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </button>
          </div>
          <SavedList
            items={saved.map((s) => ({ id: s.id, label: s.name, sub: s.request.method }))}
            onLoad={(id) => {
              const found = saved.find((s) => s.id === id);
              if (found) {
                load(found.request);
                setName(found.name);
              }
            }}
            onDelete={(id) => del.mutate(id)}
          />
        </div>
      </div>
    </div>
  );
}
