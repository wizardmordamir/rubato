import {
  type AuthConfig,
  type BodyConfig,
  type Environment,
  emptyRequest,
  HTTP_METHODS,
  type HttpRequest,
  type HttpResult,
  type MultipartField,
  resolveVars,
} from "@shared/request/model";
import { parseCurl } from "@shared/request/parseCurl";
import { buildCurl, buildFetch, interpolate, parseRequestFile, toRequestFile } from "@shared/request/transforms";
import { formatJson } from "@shared/tools/json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import {
  deleteEnvironment,
  deleteHttpRequest,
  fetchEnvironments,
  fetchRequests,
  runHttpRequest,
  saveEnvironment,
  saveHttpRequest,
} from "../api";
import { Badge, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, PageHeading, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { usePrompt } from "../prompt";
import { useToast } from "../toast";
import { CopyButton, OutputBox } from "./tools/toolkit";
import { KvEditor } from "./requests/KvEditor";

const ENV_KEY = "rubato.requests.env";
type ReqTab = "params" | "headers" | "auth" | "body";

/** Trigger a client-side file download. */
function download(filename: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function statusTone(status: number): "success" | "accent" | "error" {
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "accent";
  return "error";
}

export function RequestsPage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const [req, setReq] = useState<HttpRequest>(() => ({ ...emptyRequest(), url: "https://api.example.com/v1/things" }));
  const [name, setName] = useState("");
  const [loadedId, setLoadedId] = useState<string | undefined>();
  const [tab, setTab] = useState<ReqTab>("params");
  const [result, setResult] = useState<HttpResult | null>(null);
  const [activeEnvId, setActiveEnvId] = useState(() => localStorage.getItem(ENV_KEY) ?? "");
  const [curlImport, setCurlImport] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: saved = [] } = useQuery({ queryKey: ["http-requests"], queryFn: fetchRequests });
  const { data: envs = [] } = useQuery({ queryKey: ["http-envs"], queryFn: fetchEnvironments });

  const activeEnv = envs.find((e) => e.id === activeEnvId);
  const vars = activeEnv ? resolveVars(activeEnv.variables) : {};
  const effectiveReq = activeEnv ? interpolate(req, vars) : req;
  const curl = useMemo(() => buildCurl(effectiveReq), [effectiveReq]);
  const fetchSnippet = useMemo(() => buildFetch(effectiveReq), [effectiveReq]);

  const patch = (p: Partial<HttpRequest>) => setReq((r) => ({ ...r, ...p }));

  const run = useMutation({
    mutationFn: () => runHttpRequest(req, activeEnv ? vars : undefined),
    onSuccess: (r) => {
      setResult(r);
      if (r.error) notify(r.error, "error");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "request failed", "error"),
  });

  const save = useMutation({
    mutationFn: () => saveHttpRequest({ id: loadedId, name: name.trim() || "Untitled", request: req }),
    onSuccess: (s) => {
      setLoadedId(s.id);
      setName(s.name);
      notify("Saved", "success");
      qc.invalidateQueries({ queryKey: ["http-requests"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });
  const delReq = useMutation({
    mutationFn: (id: string) => deleteHttpRequest(id),
    onSuccess: (_r, id) => {
      if (id === loadedId) newRequest();
      qc.invalidateQueries({ queryKey: ["http-requests"] });
    },
  });

  const saveEnv = useMutation({
    mutationFn: (e: Environment) => saveEnvironment({ id: e.id, name: e.name, variables: e.variables }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["http-envs"] }),
  });
  const delEnv = useMutation({
    mutationFn: (id: string) => deleteEnvironment(id),
    onSuccess: (_r, id) => {
      if (id === activeEnvId) selectEnv("");
      qc.invalidateQueries({ queryKey: ["http-envs"] });
    },
  });

  function newRequest() {
    setReq(emptyRequest());
    setName("");
    setLoadedId(undefined);
    setResult(null);
  }
  function loadSaved(s: { id: string; name: string; request: HttpRequest }) {
    setReq(s.request);
    setName(s.name);
    setLoadedId(s.id);
    setResult(null);
  }
  function duplicate() {
    setLoadedId(undefined);
    setName((n) => `${n || "Untitled"} copy`);
    notify("Duplicated — Save to keep it", "success");
  }
  function selectEnv(id: string) {
    setActiveEnvId(id);
    localStorage.setItem(ENV_KEY, id);
  }
  async function onImportFile(files: FileList | null) {
    if (!files?.[0]) return;
    try {
      const parsed = parseRequestFile(JSON.parse(await files[0].text()));
      setReq(parsed);
      setLoadedId(undefined);
      setName(files[0].name.replace(/\.json$/, ""));
      setResult(null);
      notify("Imported", "success");
    } catch (e) {
      notify(e instanceof Error ? e.message : "invalid request file", "error");
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  const prettyBody = useMemo(() => {
    if (!result?.body) return "";
    if (result.contentType.includes("json") || /^\s*[[{]/.test(result.body)) {
      const f = formatJson(result.body, { strictOutput: false, indent: 2 });
      if (f.ok) return f.output;
    }
    return result.body;
  }, [result]);

  return (
    <div className="flex h-full flex-col gap-4 lg:flex-row">
      {/* Sidebar: environment + saved requests — stacks on top on small screens */}
      <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-56 lg:overflow-auto">
        <div>
          <div className="mb-1 text-xs font-medium text-gray-500">Environment</div>
          <select value={activeEnvId} onChange={(e) => selectEnv(e.target.value)} className={`${FIELD_CLASS} py-1`}>
            <option value="">No environment</option>
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <EnvManager
            envs={envs}
            activeEnvId={activeEnvId}
            onSave={(e) => saveEnv.mutate(e)}
            onDelete={(id) => delEnv.mutate(id)}
            onSelect={selectEnv}
          />
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500">Saved ({saved.length})</span>
            <Tooltip multiline content="Clears the builder to a blank HTTP request (method, URL, headers, params, auth, and body) so you can compose a new one. Save it to add it to this Saved list.">
              <button type="button" className={`${BTN_GHOST_CLASS} ml-auto py-0.5`} onClick={newRequest}>
                + New
              </button>
            </Tooltip>
          </div>
          <ul className="max-h-44 space-y-0.5 overflow-auto lg:max-h-none">
            {saved.map((s) => (
              <li key={s.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => loadSaved(s)}
                  className={`flex-1 truncate rounded px-2 py-1 text-left text-sm ${
                    s.id === loadedId ? "bg-accent-soft text-accent" : "hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  <MethodTag method={s.request.method} /> {s.name}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (await confirm({ prompt: "Delete this request?", confirmText: "Delete" })) delReq.mutate(s.id);
                  }}
                  className="shrink-0 px-1 text-gray-400 hover:text-red-500"
                  aria-label="delete"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Main builder */}
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeading
          title="Requests"
          toolbar={
            <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
              <input
                className={`${FIELD_CLASS} w-full py-2 sm:w-auto sm:min-w-[12rem] sm:max-w-xs sm:flex-1`}
                placeholder="Request name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={BTN_PRIMARY_CLASS} onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : loadedId ? "Save" : "Save new"}
                </button>
                <Tooltip multiline content="Makes an unsaved copy of this request (same method/URL/headers/body, but no longer linked to the saved one). Save it to keep the copy as a separate request.">
                  <button type="button" className={BTN_GHOST_CLASS} onClick={duplicate} disabled={!loadedId && !name}>
                    Duplicate
                  </button>
                </Tooltip>
                <span className="mx-0.5 hidden h-5 w-px bg-gray-200 sm:block dark:bg-gray-700" aria-hidden />
                <Tooltip multiline content="Downloads the current request (method, URL, headers, params, auth, and body) as a .json file you can share or commit. Reload it later with Import.">
                  <button
                    type="button"
                    className={BTN_GHOST_CLASS}
                    onClick={() => download(`${(name || "request").replace(/\s+/g, "-")}.json`, JSON.stringify(toRequestFile(req, name), null, 2))}
                  >
                    Export
                  </button>
                </Tooltip>
                <Tooltip multiline content="Loads a request from a previously exported .json file into the builder, replacing the current form. It does not save it — Save to keep it.">
                  <button type="button" className={BTN_GHOST_CLASS} onClick={() => fileRef.current?.click()}>
                    Import
                  </button>
                </Tooltip>
                <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={(e) => onImportFile(e.target.files)} />
              </div>
            </div>
          }
        />

        {/* URL bar — method + URL are one combined control so the URL field always
            has room; Send drops below it on small screens. Submitting sends. */}
        <form
          className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-stretch"
          onSubmit={(e) => {
            e.preventDefault();
            if (req.url.trim() && !run.isPending) run.mutate();
          }}
        >
          <div className="flex min-w-0 flex-1 items-stretch overflow-hidden rounded-lg border border-gray-300 bg-white transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30 dark:border-gray-700 dark:bg-gray-900">
            <select
              value={req.method}
              onChange={(e) => patch({ method: e.target.value as HttpRequest["method"] })}
              aria-label="HTTP method"
              className="shrink-0 cursor-pointer border-0 bg-transparent py-2.5 pr-7 pl-3 font-mono text-sm font-semibold text-gray-900 focus:outline-none dark:text-gray-100"
            >
              {HTTP_METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <span className="my-2 w-px shrink-0 bg-gray-200 dark:bg-gray-700" aria-hidden />
            <input
              className="min-w-0 flex-1 border-0 bg-transparent px-3 py-2.5 font-mono text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none dark:text-gray-100 dark:placeholder:text-gray-500"
              placeholder="https://api.example.com/path  —  {{var}} for env values"
              value={req.url}
              onChange={(e) => patch({ url: e.target.value })}
              aria-label="Request URL"
            />
          </div>
          <button
            type="submit"
            className={`${BTN_PRIMARY_CLASS} h-11 justify-center px-6 text-base sm:h-auto sm:text-sm`}
            disabled={!req.url.trim() || run.isPending}
          >
            {run.isPending ? "Sending…" : "Send"}
          </button>
        </form>

        {/* Request config tabs */}
        <div className="mb-2 flex items-center gap-2 border-gray-200 border-b dark:border-gray-800">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
            {(["params", "headers", "auth", "body"] as ReqTab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`-mb-px shrink-0 border-b-2 px-3 py-2 capitalize ${
                  t === tab ? "border-accent font-medium text-accent" : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                {t}
                {t === "params" && req.query.length ? ` (${req.query.length})` : ""}
                {t === "headers" && req.headers.length ? ` (${req.headers.length})` : ""}
              </button>
            ))}
          </div>
          <Tooltip multiline content="Paste a curl command and have it parsed into this builder — method, URL, headers, auth, and body are filled in from the command.">
            <button type="button" className={`${BTN_GHOST_CLASS} shrink-0 py-1`} onClick={() => setCurlImport("")}>
              Paste curl
            </button>
          </Tooltip>
        </div>

        <div className="min-h-[7rem]">
          {tab === "params" && <KvEditor rows={req.query} onChange={(query) => patch({ query })} />}
          {tab === "headers" && <KvEditor rows={req.headers} onChange={(headers) => patch({ headers })} keyPlaceholder="Header" />}
          {tab === "auth" && <AuthEditor auth={req.auth} onChange={(auth) => patch({ auth })} />}
          {tab === "body" && <BodyEditor body={req.body} onChange={(body) => patch({ body })} />}
        </div>

        {/* curl/fetch export */}
        <div className="mt-2">
          <button type="button" className="text-xs text-gray-400 hover:text-accent" onClick={() => setShowCode((s) => !s)}>
            {showCode ? "▾" : "▸"} View as curl / fetch
          </button>
          {showCode && (
            <div className="mt-2 grid gap-2 lg:grid-cols-2">
              <OutputBox title="curl" text={curl} />
              <OutputBox title="fetch" text={fetchSnippet} />
            </div>
          )}
        </div>

        {/* Response */}
        <div className="mt-3 flex-1">
          {result ? (
            <ResponsePanel result={result} prettyBody={prettyBody} requestName={name} download={download} />
          ) : (
            <p className="mt-6 text-center text-sm text-gray-400">Send a request to see the response.</p>
          )}
        </div>
      </div>

      {curlImport !== null && (
        <CurlImportModal
          value={curlImport}
          onChange={setCurlImport}
          onClose={() => setCurlImport(null)}
          onParse={(text) => {
            setReq(parseCurl(text));
            setCurlImport(null);
            setResult(null);
            notify("Parsed curl into the builder", "success");
          }}
        />
      )}
    </div>
  );
}

function MethodTag({ method }: { method: string }) {
  return <span className="font-mono text-[10px] text-gray-400">{method}</span>;
}

function AuthEditor({ auth, onChange }: { auth: AuthConfig; onChange: (a: AuthConfig) => void }) {
  return (
    <div className="space-y-2">
      <select
        value={auth.type}
        onChange={(e) => {
          const t = e.target.value as AuthConfig["type"];
          onChange(
            t === "basic"
              ? { type: "basic", username: "", password: "" }
              : t === "bearer"
                ? { type: "bearer", token: "" }
                : t === "apiKey"
                  ? { type: "apiKey", key: "", value: "", in: "header" }
                  : { type: "none" },
          );
        }}
        className={`${FIELD_CLASS} w-full sm:max-w-48`}
      >
        <option value="none">No auth</option>
        <option value="basic">Basic</option>
        <option value="bearer">Bearer</option>
        <option value="apiKey">API key</option>
      </select>
      {auth.type === "basic" && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className={`${FIELD_CLASS} min-w-0 sm:flex-1`} placeholder="username" value={auth.username} onChange={(e) => onChange({ ...auth, username: e.target.value })} />
          <input className={`${FIELD_CLASS} min-w-0 sm:flex-1`} placeholder="password" value={auth.password} onChange={(e) => onChange({ ...auth, password: e.target.value })} />
        </div>
      )}
      {auth.type === "bearer" && (
        <input className={FIELD_CLASS} placeholder="token" value={auth.token} onChange={(e) => onChange({ ...auth, token: e.target.value })} />
      )}
      {auth.type === "apiKey" && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className={`${FIELD_CLASS} min-w-0 sm:flex-1`} placeholder="key (e.g. X-API-Key)" value={auth.key} onChange={(e) => onChange({ ...auth, key: e.target.value })} />
          <input className={`${FIELD_CLASS} min-w-0 sm:flex-1`} placeholder="value" value={auth.value} onChange={(e) => onChange({ ...auth, value: e.target.value })} />
          <select className={`${FIELD_CLASS} w-full sm:w-28 sm:shrink-0`} value={auth.in} onChange={(e) => onChange({ ...auth, in: e.target.value as "header" | "query" })}>
            <option value="header">header</option>
            <option value="query">query</option>
          </select>
        </div>
      )}
    </div>
  );
}

const TEXTAREA_CLASS =
  "w-full h-40 rounded-lg border border-gray-300 bg-white p-3 font-mono text-xs dark:border-gray-700 dark:bg-gray-900 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";

function BodyEditor({ body, onChange }: { body: BodyConfig; onChange: (b: BodyConfig) => void }) {
  return (
    <div className="space-y-2">
      <select
        value={body.type}
        onChange={(e) => {
          const t = e.target.value as BodyConfig["type"];
          onChange(
            t === "json"
              ? { type: "json", text: "" }
              : t === "raw"
                ? { type: "raw", text: "", contentType: "text/plain" }
                : t === "form"
                  ? { type: "form", fields: [] }
                  : t === "multipart"
                    ? { type: "multipart", fields: [] }
                    : { type: "none" },
          );
        }}
        className={`${FIELD_CLASS} w-full sm:max-w-52`}
      >
        <option value="none">No body</option>
        <option value="json">JSON</option>
        <option value="raw">Raw</option>
        <option value="form">Form (urlencoded)</option>
        <option value="multipart">Multipart (files)</option>
      </select>
      {body.type === "json" && (
        <textarea className={TEXTAREA_CLASS} placeholder='{ "key": "value" }' value={body.text} onChange={(e) => onChange({ ...body, text: e.target.value })} spellCheck={false} />
      )}
      {body.type === "raw" && (
        <div className="space-y-1.5">
          <input className={`${FIELD_CLASS} w-full py-1 sm:max-w-sm`} placeholder="content-type" value={body.contentType} onChange={(e) => onChange({ ...body, contentType: e.target.value })} />
          <textarea className={TEXTAREA_CLASS} value={body.text} onChange={(e) => onChange({ ...body, text: e.target.value })} spellCheck={false} />
        </div>
      )}
      {body.type === "form" && <KvEditor rows={body.fields} onChange={(fields) => onChange({ ...body, fields })} />}
      {body.type === "multipart" && <MultipartEditor fields={body.fields} onChange={(fields) => onChange({ ...body, fields })} />}
    </div>
  );
}

function MultipartEditor({ fields, onChange }: { fields: MultipartField[]; onChange: (f: MultipartField[]) => void }) {
  const set = (i: number, f: MultipartField) => onChange(fields.map((x, j) => (j === i ? f : x)));
  const readFile = (i: number, key: string, file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result).split(",")[1] ?? "";
      set(i, { kind: "file", key, filename: file.name, contentBase64: b64, contentType: file.type, enabled: true });
    };
    reader.readAsDataURL(file);
  };
  return (
    <div className="space-y-1.5">
      {fields.map((f, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <input type="checkbox" className="shrink-0" checked={f.enabled} onChange={(e) => set(i, { ...f, enabled: e.target.checked })} />
          <input
            className={`${FIELD_CLASS} shrink-0 basis-28 py-1 font-mono`}
            placeholder="field"
            value={f.key}
            onChange={(e) => set(i, { ...f, key: e.target.value })}
          />
          <select
            className={`${FIELD_CLASS} shrink-0 basis-20 py-1`}
            value={f.kind}
            onChange={(e) =>
              set(i, e.target.value === "file" ? { kind: "file", key: f.key, filename: "", contentBase64: "", enabled: f.enabled } : { kind: "text", key: f.key, value: "", enabled: f.enabled })
            }
          >
            <option value="text">text</option>
            <option value="file">file</option>
          </select>
          {f.kind === "text" ? (
            <input className={`${FIELD_CLASS} min-w-0 flex-1 basis-40 py-1 font-mono`} placeholder="value" value={f.value} onChange={(e) => set(i, { ...f, value: e.target.value })} />
          ) : (
            <label className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-xs text-gray-500">
              <input type="file" className="min-w-0" onChange={(e) => e.target.files?.[0] && readFile(i, f.key, e.target.files[0])} />
              {f.filename && <span className="truncate">📎 {f.filename}</span>}
            </label>
          )}
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => onChange(fields.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="flex gap-1.5">
        <button type="button" className={BTN_GHOST_CLASS} onClick={() => onChange([...fields, { kind: "text", key: "", value: "", enabled: true }])}>
          + text
        </button>
        <button type="button" className={BTN_GHOST_CLASS} onClick={() => onChange([...fields, { kind: "file", key: "", filename: "", contentBase64: "", enabled: true }])}>
          + file
        </button>
      </div>
    </div>
  );
}

function ResponsePanel({
  result,
  prettyBody,
  requestName,
  download: dl,
}: {
  result: HttpResult;
  prettyBody: string;
  requestName: string;
  download: (f: string, t: string, type?: string) => void;
}) {
  const [tab, setTab] = useState<"body" | "headers">("body");
  const kb = (result.sizeBytes / 1024).toFixed(1);
  return (
    <div className={`${CARD_CLASS} flex h-full flex-col p-0`}>
      <div className="flex flex-wrap items-center gap-2 border-gray-200 border-b px-3 py-2 dark:border-gray-800">
        {result.status > 0 ? (
          <Badge tone={statusTone(result.status)}>
            {result.status} {result.statusText}
          </Badge>
        ) : (
          <Badge tone="error">{result.error ?? "failed"}</Badge>
        )}
        <span className="text-xs text-gray-400">{result.durationMs} ms · {kb} KB</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex rounded-lg border border-gray-200 text-xs dark:border-gray-800">
            <button type="button" className={`px-2 py-0.5 ${tab === "body" ? "text-accent" : "text-gray-500"}`} onClick={() => setTab("body")}>
              Body
            </button>
            <button type="button" className={`px-2 py-0.5 ${tab === "headers" ? "text-accent" : "text-gray-500"}`} onClick={() => setTab("headers")}>
              Headers ({result.headers.length})
            </button>
          </span>
          <CopyButton text={tab === "body" ? prettyBody : result.headers.map(([k, v]) => `${k}: ${v}`).join("\n")} />
          <button
            type="button"
            className={BTN_GHOST_CLASS}
            onClick={() => dl(`${(requestName || "response").replace(/\s+/g, "-")}.txt`, prettyBody || result.body, "text/plain")}
          >
            Save
          </button>
        </div>
      </div>
      <pre className="flex-1 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
        {tab === "body"
          ? prettyBody || <span className="text-gray-400">(empty body)</span>
          : result.headers.map(([k, v]) => `${k}: ${v}`).join("\n")}
      </pre>
    </div>
  );
}

function CurlImportModal({
  value,
  onChange,
  onClose,
  onParse,
}: {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onParse: (text: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation panel */}
      <div className={`${CARD_CLASS} w-full max-w-2xl p-4`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 text-sm font-medium">Import a curl command</div>
        <textarea
          className={TEXTAREA_CLASS}
          placeholder="curl 'https://api.example.com/x' -H 'Authorization: Bearer …' --data '{…}'"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: focus the paste target
          autoFocus
        />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={onClose}>
            Cancel
          </button>
          <Tooltip multiline content="Parses the pasted curl command and loads its method, URL, headers, auth, and body into the builder, replacing the current request.">
            <button type="button" className={BTN_PRIMARY_CLASS} disabled={!value.trim()} onClick={() => onParse(value)}>
              Parse into builder
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function EnvManager({
  envs,
  activeEnvId,
  onSave,
  onDelete,
  onSelect,
}: {
  envs: Environment[];
  activeEnvId: string;
  onSave: (e: Environment) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const prompt = usePrompt();
  const confirm = useConfirm();
  const active = envs.find((e) => e.id === activeEnvId);
  return (
    <div className="mt-1">
      <button type="button" className="text-xs text-gray-400 hover:text-accent" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} manage
      </button>
      {open && (
        <div className={`${CARD_CLASS} mt-1 space-y-2 p-2`}>
          <Tooltip multiline content="Creates a new environment — a named set of {{variable}} values (e.g. baseUrl, token) you can switch between so the same request runs against dev, staging, or prod without editing it.">
            <button
              type="button"
              className={`${BTN_GHOST_CLASS} w-full py-0.5`}
              onClick={async () => {
                const name = await prompt({ prompt: "New environment name", confirmText: "Create" });
                if (name?.trim())
                  onSave({ id: "", name: name.trim(), variables: [], createdAt: 0, updatedAt: 0 } as Environment);
              }}
            >
              + New environment
            </button>
          </Tooltip>
          {active && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-xs">
                <span className="font-medium">{active.name}</span>
                <button
                  type="button"
                  className="ml-auto text-gray-400 hover:text-red-500"
                  onClick={async () => {
                    if (await confirm({ prompt: "Delete this environment?", confirmText: "Delete" })) onDelete(active.id);
                  }}
                >
                  delete
                </button>
              </div>
              <KvEditor
                rows={active.variables}
                onChange={(variables) => onSave({ ...active, variables })}
                keyPlaceholder="var (e.g. baseUrl)"
              />
            </div>
          )}
          {!active && <p className="text-xs text-gray-400">Pick an environment above to edit its variables.</p>}
          {envs.length > 0 && !active && (
            <div className="text-xs text-gray-400">{envs.length} environment(s). Select one to switch APIs.</div>
          )}
          <div className="flex flex-wrap gap-1">
            {envs.map((e) => (
              <button
                key={e.id}
                type="button"
                className={`${BTN_GHOST_CLASS} py-0.5 ${e.id === activeEnvId ? "text-accent" : ""}`}
                onClick={() => onSelect(e.id)}
              >
                {e.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
