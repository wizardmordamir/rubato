// One player for both replayable worlds: a recorded capture and a finished run.
// Feed it Moments (see @shared/timeline adapters) and it gives a left rail of
// steps plus a viewport you can step through (Prev/Next), scrub (click a step),
// or auto-play — paced by the same smart-wait heuristic as runs, so screens that
// did something get a beat to be seen. Screenshot / HTML / Network / Details tabs
// (+ a run-level Server logs tab when a correlationId is supplied).

import { type RunSpeed, smartWaitMs } from "@shared/pacing";
import type { Moment } from "@shared/timeline";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { fetchDebugLogs } from "../api";
import { Dropdown, Tooltip } from "../components";

const STATUS_DOT: Record<string, string> = {
  running: "bg-amber-400",
  passed: "bg-emerald-500",
  failed: "bg-red-500",
  skipped: "bg-gray-400",
};

type Tab = "shot" | "html" | "network" | "details" | "serverlogs";
const PLAY_SPEEDS: readonly RunSpeed[] = ["slow", "slower"];

/** `correlationId` (run only) enables the run-level Server logs tab. */
export function TimelinePlayer({ moments, correlationId }: { moments: Moment[]; correlationId?: string }) {
  const [sel, setSel] = useState(0);
  const [tab, setTab] = useState<Tab>("shot");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<RunSpeed>("slow");

  const count = moments.length;
  const cur = moments[Math.min(sel, count - 1)];

  // Clamp the selection if the moments list shrinks (e.g. a live run restarts).
  useEffect(() => {
    if (sel > count - 1) setSel(Math.max(0, count - 1));
  }, [count, sel]);

  // Auto-play: advance after a paced delay; stop at the end.
  useEffect(() => {
    if (!playing || count === 0) return;
    if (sel >= count - 1) {
      setPlaying(false);
      return;
    }
    const delay = Math.max(500, smartWaitMs(cur?.action, speed));
    const t = setTimeout(() => setSel((i) => Math.min(i + 1, count - 1)), delay);
    return () => clearTimeout(t);
  }, [playing, sel, count, speed, cur?.action]);

  if (count === 0) return <p className="p-3 text-gray-500 text-sm">Nothing to play — no steps were recorded.</p>;

  const go = (i: number) => {
    setPlaying(false);
    setSel(Math.max(0, Math.min(i, count - 1)));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Transport */}
      <div className="flex flex-wrap items-center gap-2 border-gray-200 border-b p-2 text-sm dark:border-gray-800">
        <button type="button" onClick={() => go(sel - 1)} disabled={sel <= 0} className={CTRL}>
          ◀ Prev
        </button>
        <button
          type="button"
          onClick={() => (sel >= count - 1 ? (setSel(0), setPlaying(true)) : setPlaying((p) => !p))}
          className={CTRL}
        >
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button type="button" onClick={() => go(sel + 1)} disabled={sel >= count - 1} className={CTRL}>
          Next ▶
        </button>
        <Tooltip content="Auto-play pace">
          <label className="flex items-center gap-1 text-gray-500 text-xs">
            speed
            <Dropdown
              aria-label="Auto-play pace"
              value={speed}
              onChange={(v) => setSpeed(v as RunSpeed)}
              options={PLAY_SPEEDS.map((s) => ({ value: s, label: s }))}
            />
          </label>
        </Tooltip>
        <span className="ml-auto font-mono text-gray-400 text-xs">
          {sel + 1} / {count}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Step rail */}
        <div className="w-56 shrink-0 overflow-auto border-gray-200 border-r dark:border-gray-800">
          {moments.map((m, i) => (
            <Tooltip key={m.key} content={m.url ?? ""} className="block">
              <button
                type="button"
                onClick={() => go(i)}
                className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs ${
                  i === sel ? "bg-accent/10 text-accent" : "hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                {m.status && <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[m.status] ?? "bg-gray-300"}`} />}
                <span className="font-mono text-gray-400">{m.index}</span>
                <span className="truncate">{m.label}</span>
              </button>
            </Tooltip>
          ))}
        </div>

        {/* Viewport */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-gray-200 border-b p-2 text-xs dark:border-gray-800">
            <TabBtn tab="shot" cur={tab} set={setTab}>
              Screenshot
            </TabBtn>
            <TabBtn tab="html" cur={tab} set={setTab}>
              HTML
            </TabBtn>
            <TabBtn tab="network" cur={tab} set={setTab}>
              Network{cur?.network?.length ? ` (${cur.network.length})` : ""}
            </TabBtn>
            <TabBtn tab="details" cur={tab} set={setTab}>
              Details
            </TabBtn>
            {correlationId && (
              <TabBtn tab="serverlogs" cur={tab} set={setTab}>
                Server logs
              </TabBtn>
            )}
            {cur?.url && (
              <Tooltip content={cur.url} className="ml-auto">
                <span className="max-w-[40%] truncate font-mono text-gray-400">
                  {cur.url}
                </span>
              </Tooltip>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {tab === "shot" &&
              (cur?.screenshotUrl ? (
                // biome-ignore lint/a11y/useAltText: a captured page screenshot.
                <img src={cur.screenshotUrl} className="max-w-full border border-gray-200 dark:border-gray-800" />
              ) : (
                <p className="text-gray-500 text-sm">No screenshot for this step.</p>
              ))}
            {tab === "html" &&
              (cur?.htmlUrl ? (
                <iframe
                  title="captured html"
                  src={cur.htmlUrl}
                  sandbox=""
                  className="h-full min-h-96 w-full border border-gray-200 dark:border-gray-800"
                />
              ) : (
                <p className="text-gray-500 text-sm">No HTML for this step.</p>
              ))}
            {tab === "network" && <NetworkTab m={cur} />}
            {tab === "details" && <Details m={cur} />}
            {tab === "serverlogs" && <ServerLogsTab correlationId={correlationId} />}
          </div>
        </div>
      </div>
    </div>
  );
}

const CTRL =
  "rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800";

function TabBtn({ tab, cur, set, children }: { tab: Tab; cur: Tab; set: (t: Tab) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => set(tab)}
      className={cur === tab ? "font-medium text-accent" : "text-gray-500 hover:text-accent"}
    >
      {children}
    </button>
  );
}

/** Per-step page network (method/status/timing/url) — metadata only. */
function NetworkTab({ m }: { m?: Moment }) {
  const net = m?.network;
  if (!net || net.length === 0) return <p className="text-gray-500 text-sm">No network captured for this step.</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-gray-400">
          <th className="pr-2 font-medium">Method</th>
          <th className="pr-2 font-medium">Status</th>
          <th className="pr-2 font-medium">ms</th>
          <th className="font-medium">URL</th>
        </tr>
      </thead>
      <tbody>
        {net.map((e, i) => (
          <tr key={`${e.method}-${e.url}-${i}`} className="border-gray-100 border-t dark:border-gray-800">
            <td className="pr-2 font-mono">{e.method}</td>
            <td
              className={`pr-2 font-mono ${e.failed ? "text-red-500" : e.status >= 400 ? "text-amber-600" : "text-emerald-600"}`}
            >
              {e.failed ? "ERR" : e.status}
            </td>
            <td className="pr-2 font-mono text-gray-400">{e.durationMs ?? ""}</td>
            <td className="max-w-0 truncate font-mono text-gray-600 dark:text-gray-300">
              <Tooltip content={e.url}>
                <span>{e.url}</span>
              </Tooltip>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Run-level: the server logs + outbound API/DB calls for the run's correlation id. */
function ServerLogsTab({ correlationId }: { correlationId?: string }) {
  const q = useQuery({
    queryKey: ["debug-logs", correlationId],
    queryFn: () => fetchDebugLogs(correlationId as string),
    enabled: !!correlationId,
  });
  if (!correlationId) return <p className="text-gray-500 text-sm">Server logs are available for automation runs.</p>;
  if (q.isLoading) return <p className="text-gray-500 text-sm">Loading…</p>;
  const data = q.data;
  if (!data || (data.logs.length === 0 && data.captures.length === 0))
    return <p className="text-gray-500 text-sm">No server logs recorded for this run.</p>;
  return (
    <div className="space-y-3 text-xs">
      {data.captures.length > 0 && (
        <div>
          <div className="mb-1 font-semibold text-gray-500">Outbound calls ({data.captures.length})</div>
          <ul className="space-y-0.5 font-mono text-gray-600 dark:text-gray-300">
            {data.captures.map((c, i) => (
              <Tooltip key={`${c.label}-${i}`} content={c.label} className="block">
                <li className="truncate">
                  {(c.kind ?? "call") + " · " + c.label}
                  {c.error ? " · error" : ""}
                </li>
              </Tooltip>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="mb-1 font-semibold text-gray-500">Server logs ({data.logs.length})</div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-gray-100 p-2 font-mono text-gray-600 dark:bg-gray-800/70 dark:text-gray-300">
          {data.logs.map((l) => `${l.level.padEnd(5)} ${l.msg}`).join("\n")}
        </pre>
      </div>
    </div>
  );
}

function Details({ m }: { m?: Moment }) {
  if (!m) return null;
  return (
    <div className="space-y-2 text-xs">
      <div className="font-mono text-gray-400">
        {m.label}
        {m.durationMs != null && ` · ${m.durationMs}ms`}
        {m.status && ` · ${m.status}`}
      </div>
      {m.error && <div className="whitespace-pre-wrap font-mono text-red-500">{m.error}</div>}
      {m.scraped && (
        <div className="font-mono text-emerald-600">
          {m.scraped.name} = {m.scraped.value}
        </div>
      )}
      {m.logs && m.logs.length > 0 && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-gray-100 p-2 font-mono text-gray-600 dark:bg-gray-800/70 dark:text-gray-300">
          {m.logs.join("\n")}
        </pre>
      )}
      {!m.error && !m.scraped && !(m.logs && m.logs.length) && <p className="text-gray-500">No extra details.</p>}
    </div>
  );
}
