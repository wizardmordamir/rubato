// The "Scripts" page: run your custom functions — registered in-process by an
// embedding app (`registerScript`) or dropped as `~/.rubato/scripts/*.ts`. Each
// script shows its declared params as a small form; running streams stdout/stderr
// live over /ws and links the captured output in the Files tab.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import { type ScriptInfo, fetchScripts, runScript } from "../api";
import { CARD_CLASS, OpenPathButton, PageHeading, Switch } from "../components";
import { useServerEvent } from "../liveBus";
import { useToast } from "../toast";

interface RunState {
  running: boolean;
  output: string;
  status?: "passed" | "failed";
  outputPath?: string;
  /** The per-run working dir this run used — surfaced with an open-in-editor link. */
  runDir?: string;
}

// Directory phrases a script's prose mentions (e.g. "…in the run dir"), mapped to
// the concrete path. We render an open-in-editor button right after the words so
// the user can jump straight to the folder to see what it holds and where it is.
// A specific run's dir is also surfaced once it has run; this covers the generic
// mention in the description text.
const DIR_HINTS: { re: RegExp; path: string }[] = [
  { re: /run dir(ectory)?/gi, path: "~/.rubato/pipeline-runs" },
  { re: /outputs? dir(ectory)?/gi, path: "~/.rubato/outputs" },
];

/**
 * Render description text, appending an open-in-editor button after each known
 * directory phrase it mentions. Returns the text unchanged when none appear.
 */
function describeWithDirs(text: string): ReactNode {
  const hits: { index: number; length: number; path: string }[] = [];
  for (const { re, path } of DIR_HINTS) {
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue;
      hits.push({ index: m.index, length: m[0].length, path });
    }
  }
  if (hits.length === 0) return text;
  hits.sort((a, b) => a.index - b.index);
  const nodes: ReactNode[] = [];
  let pos = 0;
  hits.forEach((h, i) => {
    if (h.index < pos) return; // overlapping match — skip
    if (h.index > pos) nodes.push(text.slice(pos, h.index));
    nodes.push(
      <span key={i} className="whitespace-nowrap">
        {text.slice(h.index, h.index + h.length)}
        <OpenPathButton
          path={h.path}
          size={12}
          className="ml-0.5 inline-flex shrink-0 items-center justify-center rounded p-0.5 align-middle text-gray-400 transition-colors hover:text-accent disabled:opacity-50"
        />
      </span>,
    );
    pos = h.index + h.length;
  });
  if (pos < text.length) nodes.push(text.slice(pos));
  return nodes;
}

export function ScriptsPage() {
  const { notify } = useToast();
  const { data = [], isLoading } = useQuery({ queryKey: ["scripts"], queryFn: fetchScripts });

  // Per-script param values and run state, keyed by script id.
  const [params, setParams] = useState<Record<string, Record<string, string>>>({});
  const [runs, setRuns] = useState<Record<string, RunState>>({});

  useServerEvent((e) => {
    if (e.type === "script:run:started") {
      setRuns((r) => ({ ...r, [e.script]: { running: true, output: "", runDir: e.runDir } }));
    } else if (e.type === "script:output") {
      setRuns((r) => ({ ...r, [e.script]: { ...(r[e.script] ?? { running: true, output: "" }), output: (r[e.script]?.output ?? "") + e.chunk } }));
    } else if (e.type === "script:run:completed") {
      setRuns((r) => ({
        ...r,
        [e.script]: {
          ...(r[e.script] ?? { output: "" }),
          running: false,
          status: e.status,
          outputPath: e.outputPath,
          runDir: e.runDir ?? r[e.script]?.runDir,
        },
      }));
      notify(e.status === "passed" ? `${e.script} passed` : `${e.script} failed`, e.status === "passed" ? "success" : "error");
    }
  });

  const setParam = (id: string, name: string, value: string) =>
    setParams((p) => ({ ...p, [id]: { ...p[id], [name]: value } }));

  // A boolean param's effective on/off: the user's toggle if set, else its
  // declared default (off when undeclared).
  const boolOn = (id: string, p: { name: string; default?: string | number | boolean }) => {
    const v = params[id]?.[p.name];
    if (v === "true") return true;
    if (v === "false") return false;
    return p.default === true || p.default === "true";
  };

  const run = async (s: ScriptInfo) => {
    const raw = params[s.id] ?? {};
    // Coerce declared param types; leave unknown/string as-is.
    const coerced: Record<string, string | number | boolean> = {};
    for (const p of s.params ?? []) {
      if (p.type === "boolean") {
        // Always send the explicit toggle state (seeded from the default until
        // toggled), so turning a default-on param off actually reaches the script.
        coerced[p.name] = boolOn(s.id, p);
        continue;
      }
      const v = raw[p.name];
      if (v === undefined || v === "") continue;
      coerced[p.name] = p.type === "number" ? Number(v) : v;
    }
    setRuns((r) => ({ ...r, [s.id]: { running: true, output: "" } }));
    try {
      await runScript({ id: s.id, params: coerced });
    } catch (err) {
      setRuns((r) => ({ ...r, [s.id]: { running: false, output: err instanceof Error ? err.message : "run failed", status: "failed" } }));
      notify(err instanceof Error ? err.message : "run failed", "error");
    }
  };

  return (
    <div>
      <PageHeading title="Scripts" count={data.length} />
      <p className="mb-4 text-xs text-gray-400">
        Custom functions: TypeScript an embedding app registers in-process, or <code>~/.rubato/scripts/*.ts</code>
        <OpenPathButton path="~/.rubato/scripts" /> files.
        Each runs in its own working directory under <code>~/.rubato/pipeline-runs</code>
        <OpenPathButton path="~/.rubato/pipeline-runs" /> and can hand values to later pipeline stages.
      </p>

      {isLoading && <p className="text-gray-400">Loading…</p>}
      {!isLoading && data.length === 0 && (
        <p className="text-gray-400">
          No scripts yet — register one via <code>registerScript()</code> or add a <code>~/.rubato/scripts/*.ts</code>
          <OpenPathButton path="~/.rubato/scripts" /> file.
        </p>
      )}

      <ul className="space-y-3">
        {data.map((s) => {
          const state = runs[s.id];
          return (
            <li key={s.id} className={`${CARD_CLASS} p-4`}>
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-500 dark:bg-gray-800">
                      {s.source}
                    </span>
                    {s.source === "file" && s.file && <OpenPathButton path={s.file} />}
                  </div>
                  {s.description && <p className="mt-0.5 text-sm text-gray-500">{describeWithDirs(s.description)}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => run(s)}
                  disabled={state?.running}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {state?.running ? "Running…" : "▶ Run"}
                </button>
              </div>

              {(s.params?.length ?? 0) > 0 && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {s.params?.map((p) => (
                    <label key={p.name} className="block text-sm">
                      <span className="font-mono text-xs text-gray-600 dark:text-gray-400">
                        {p.name}
                        {p.required && <span className="text-amber-500"> *</span>}
                        <span className="ml-1 text-gray-400">({p.type})</span>
                      </span>
                      {p.type === "boolean" ? (
                        // Booleans are a toggle, not a "true"/"false" text field.
                        <div className="mt-1 flex items-center gap-2">
                          <Switch on={boolOn(s.id, p)} onChange={(v) => setParam(s.id, p.name, v ? "true" : "false")} label={p.name} />
                          <span className="text-xs text-gray-500">{boolOn(s.id, p) ? "on" : "off"}</span>
                        </div>
                      ) : (
                        <input
                          value={params[s.id]?.[p.name] ?? ""}
                          onChange={(e) => setParam(s.id, p.name, e.target.value)}
                          className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950"
                        />
                      )}
                      {p.description && <span className="mt-1 block text-xs text-gray-400">{describeWithDirs(p.description)}</span>}
                    </label>
                  ))}
                </div>
              )}

              {state && (state.output || state.status) && (
                <div className="mt-3">
                  {state.status && (
                    <div
                      className={`mb-1 text-xs font-medium ${
                        state.status === "passed" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                      }`}
                    >
                      {state.status === "passed" ? "✓ passed" : "✗ failed"}
                      {state.outputPath && (
                        <>
                          <span className="ml-2 font-normal text-gray-400">→ saved to Files</span>
                          <OpenPathButton path={state.outputPath} />
                        </>
                      )}
                      {state.runDir && (
                        <>
                          <span className="ml-2 font-normal text-gray-400">· run dir</span>
                          <OpenPathButton path={state.runDir} />
                        </>
                      )}
                    </div>
                  )}
                  {state.output && (
                    <pre className="max-h-64 overflow-auto rounded-md bg-gray-950 p-3 text-xs text-gray-100">
                      {state.output}
                    </pre>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
