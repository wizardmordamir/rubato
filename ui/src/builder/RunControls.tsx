// Inline run UI you can drop next to any automation: a "▶ Run" split button whose
// caret opens a small popover of run options (headless / keep open), plus a panel
// that surfaces the held-browser banner and the run verdict. Backed by
// useAutomationRunner — no trip to the editor required.

import type { BrowserChoice, DetectedBrowser } from "@shared/automation";
import type { RunSpeed } from "@shared/pacing";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { type AutomationEnvironment, fetchAutomationEnvironments, type EnvVar } from "../api";
import { Alert, Dropdown, Tooltip } from "../components";
import { RunStepLog, RunSummary } from "./RunSummary";
import { RUN_SPEEDS, speedLabel } from "./useAutomationRunner";
import type { AutomationRunner } from "./useAutomationRunner";
import { useAutomationVariables } from "./useAutomationVariables";

/**
 * "▶ Run" + a caret that reveals a popover of run options and — when the
 * automation references variables — a preload form. Variables already set in
 * ~/.rubato/.env are optional ("type to override"); absent ones are required and
 * the Run button stays disabled until they're filled. Per-run values are
 * ephemeral (sent with the run, never saved into the automation).
 */
export function RunControls({
  running,
  onRun,
  headless,
  setHeadless,
  keepOpen,
  setKeepOpen,
  speed,
  setSpeed,
  browser,
  setBrowser,
  browsers,
  automationId,
  className = "",
}: {
  running: boolean;
  onRun: (variables: Record<string, string>, urls?: string[], rows?: Record<string, string>[]) => void;
  headless: boolean;
  setHeadless: (v: boolean) => void;
  keepOpen: boolean;
  setKeepOpen: (v: boolean) => void;
  speed: RunSpeed;
  setSpeed: (v: RunSpeed) => void;
  /** Currently selected browser (undefined = server default). */
  browser: BrowserChoice | undefined;
  setBrowser: (v: BrowserChoice | undefined) => void;
  /** Available browsers detected on the server; shown in the picker. */
  browsers?: DetectedBrowser[];
  /** Drives the preload form; omit for runs with no resolvable id. */
  automationId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { variables, required } = useAutomationVariables(automationId);

  // Per-run values, reset whenever the automation changes.
  const [values, setValues] = useState<Record<string, string>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on automation switch.
  useEffect(() => setValues({}), [automationId]);

  // Environment selector: pick a named set of variables to inject into this run.
  const [selectedEnvId, setSelectedEnvId] = useState("");
  const { data: environments = [] } = useQuery({
    queryKey: ["automation-environments"],
    queryFn: fetchAutomationEnvironments,
  });
  const selectedEnv = environments.find((e) => e.id === selectedEnvId) ?? null;

  // Merge: environment vars first (lower priority), then manually entered values.
  const missing = required.filter((v) => {
    const fromEnv = selectedEnv?.variables.find((ev: EnvVar) => ev.enabled && ev.key === v.name)?.value;
    return !fromEnv && !values[v.name]?.trim();
  });
  const blocked = missing.length > 0;

  const supplied = useMemo(() => {
    const out: Record<string, string> = {};
    // Environment variables as the base layer.
    if (selectedEnv) {
      for (const ev of selectedEnv.variables) {
        if (ev.enabled && ev.key.trim()) out[ev.key.trim()] = ev.value;
      }
    }
    // Manually entered values override environment.
    for (const [k, v] of Object.entries(values)) if (v.trim()) out[k] = v;
    return out;
  }, [values, selectedEnv]);

  // Optional fan-out: run the automation against several URLs at once (one
  // parallel browser window each). One URL per line (commas also split).
  const [urlsText, setUrlsText] = useState("");
  const urls = useMemo(
    () =>
      urlsText
        .split(/[\n,]/)
        .map((u) => u.trim())
        .filter(Boolean),
    [urlsText],
  );

  // Optional MATRIX fan-out: one run per row of variables — paste CSV (header row
  // → keys) or a JSON array of objects. A `url` column overrides that run's start
  // URL. "Deploy N apps, each with its own task/version/sha/pipeline-type."
  const [rowsText, setRowsText] = useState("");
  const rows = useMemo(() => parseRows(rowsText), [rowsText]);
  // rows takes precedence over urls (matches the server).
  const fanUrls = rows.length === 0 && urls.length ? urls : undefined;
  const fanRows = rows.length ? rows : undefined;
  const fanCount = rows.length || urls.length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const browserLabel = (b: BrowserChoice | undefined): string => {
    if (!b) return "default";
    return browsers?.find((d) => d.id === b)?.label ?? b;
  };
  const mode = headless ? "headless" : keepOpen ? "headed · keep open" : "headed";

  return (
    <div ref={ref} className={`relative inline-flex ${className}`}>
      <div className="inline-flex overflow-hidden rounded-lg">
        <Tooltip
          content={
            blocked
              ? `Set ${missing.length} required variable${missing.length === 1 ? "" : "s"} first`
              : fanRows
                ? `Run ${fanCount} matrix row${fanCount === 1 ? "" : "s"} in parallel`
                : fanUrls
                  ? `Run against ${fanCount} URL${fanCount === 1 ? "" : "s"} in parallel`
                  : "Replay this automation"
          }
        >
          <button
            type="button"
            onClick={() => onRun(supplied, fanUrls, fanRows)}
            disabled={running || blocked}
            className="inline-flex items-center gap-1.5 bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {running ? "Running…" : fanCount > 1 ? `▶ Run ×${fanCount}` : "▶ Run"}
          </button>
        </Tooltip>
        <Tooltip content={blocked ? `${missing.length} variable${missing.length === 1 ? "" : "s"} needed` : `Run options (${mode})`}>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label="Run options"
            aria-expanded={open}
            className="relative border-l border-white/25 bg-accent px-1.5 text-sm text-white transition-colors hover:bg-accent-hover"
          >
            ▾
            {blocked && <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-amber-300" aria-hidden />}
          </button>
        </Tooltip>
      </div>

      {open && (
        <div className="absolute top-full right-0 z-10 mt-1 w-72 rounded-lg border border-gray-200 bg-white p-3 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900">
          {/* Environment selector — pick a named variable set to inject into this run. */}
          {environments.length > 0 && (
            <div className="mb-3">
              <div className="mb-2 text-xs font-semibold tracking-wide text-gray-400 uppercase">Environment</div>
              <Dropdown
                aria-label="Environment"
                value={selectedEnvId}
                onChange={(v) => setSelectedEnvId(v)}
                options={[
                  { value: "", label: "No environment" },
                  ...environments.map((e) => ({ value: e.id, label: e.name })),
                ]}
              />
              {selectedEnv && (
                <p className="mt-1 text-xs text-gray-400">
                  {selectedEnv.variables.filter((v: EnvVar) => v.enabled).length} variable
                  {selectedEnv.variables.filter((v: EnvVar) => v.enabled).length === 1 ? "" : "s"} injected. Manual values above override.
                </p>
              )}
            </div>
          )}
          {variables.length > 0 && (
            <div className="mb-3">
              <div className="mb-2 text-xs font-semibold tracking-wide text-gray-400 uppercase">Variables</div>
              <div className="space-y-2">
                {variables.map((v) => (
                  <label key={v.name} className="block">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs text-gray-700 dark:text-gray-300">{v.name}</span>
                      {v.present ? (
                        <Tooltip content="Set in ~/.rubato/.env">
                          <span className="text-xs text-green-600 dark:text-green-400">✓ set</span>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-amber-600 dark:text-amber-400">required</span>
                      )}
                    </div>
                    <input
                      type="password"
                      autoComplete="off"
                      value={values[v.name] ?? ""}
                      onChange={(e) => setValues((s) => ({ ...s, [v.name]: e.target.value }))}
                      placeholder={v.present ? "set in .env — type to override" : "required"}
                      className={`mt-1 w-full rounded-md border bg-white px-2 py-1 text-sm dark:bg-gray-950 ${
                        !v.present && !values[v.name]?.trim()
                          ? "border-amber-400 dark:border-amber-600"
                          : "border-gray-300 dark:border-gray-700"
                      }`}
                    />
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-400">Used only for this run — never saved into the automation.</p>
            </div>
          )}
          <div className="mb-2 text-xs font-semibold tracking-wide text-gray-400 uppercase">Run options</div>
          <Tooltip content="Run with no visible browser window.">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} />
              headless
            </label>
          </Tooltip>
          {!headless && (
            <Tooltip content="Leave the visible browser open after the run, not just on failure." className="mt-2 block">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={keepOpen} onChange={(e) => setKeepOpen(e.target.checked)} />
                keep browser open
              </label>
            </Tooltip>
          )}
          <p className="mt-2 text-xs text-gray-400">Headed runs stay open on failure so you can inspect the page.</p>

          <Tooltip
            content="Pause between steps so you can watch a run — longer after clicks/navigation, tiny after typing."
            className="mt-2 block"
          >
            <label className="flex items-center gap-2">
              <span className="text-gray-600 dark:text-gray-300">speed</span>
              <Dropdown
                aria-label="Run speed"
                value={speed}
                onChange={(v) => setSpeed(v as RunSpeed)}
                options={RUN_SPEEDS.map((s) => ({ value: s, label: speedLabel(s) }))}
              />
            </label>
          </Tooltip>
          <p className="mt-1 text-xs text-gray-400">Slowing helps you watch a headed run; off runs at full speed.</p>

          <Tooltip content="Which browser to run the automation in." className="mt-2 block">
            <label className="flex items-center gap-2">
              <span className="text-gray-600 dark:text-gray-300">browser</span>
              <Dropdown
                aria-label="Browser"
                value={browser ?? ""}
                onChange={(v) => setBrowser((v as BrowserChoice) || undefined)}
                options={[
                  { value: "", label: "default (Chrome)" },
                  ...(browsers ?? []).map((b) => ({
                    value: b.id,
                    label: b.available ? b.label : `${b.label} (not found)`,
                  })),
                ]}
              />
            </label>
          </Tooltip>
          <p className="mt-1 text-xs text-gray-400">
            {browser
              ? `Using ${browserLabel(browser)}. Install bundled browsers with \`bunx playwright install\`.`
              : "Chrome or Chromium (whichever is installed). Override per run."}
          </p>

          <div className="mt-3 mb-2 text-xs font-semibold tracking-wide text-gray-400 uppercase">
            Run across URLs
          </div>
          <textarea
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            rows={3}
            placeholder={"one URL per line — runs each in parallel\n(exposed as ${TARGET_URL})"}
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-gray-700 dark:bg-gray-950"
          />
          <p className="mt-1 text-xs text-gray-400">
            {urls.length > 0
              ? `${urls.length} target${urls.length === 1 ? "" : "s"} — each opens its own window${headless ? " (headless)" : keepOpen ? ", kept open" : ""}.`
              : "Leave empty for a single run. Each URL becomes the start URL + ${TARGET_URL}."}
          </p>

          <div className="mt-3 mb-2 text-xs font-semibold tracking-wide text-gray-400 uppercase">
            Run a variable matrix
          </div>
          <textarea
            value={rowsText}
            onChange={(e) => setRowsText(e.target.value)}
            rows={3}
            placeholder={"one run per row — paste CSV or JSON\nurl,task,version,sha\nhttps://…/job/alpha,T-9,1.2.3,sha256:…"}
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-gray-700 dark:bg-gray-950"
          />
          <p className="mt-1 text-xs text-gray-400">
            {rows.length > 0
              ? `${rows.length} row${rows.length === 1 ? "" : "s"} — each column becomes a ${"${VAR}"}; a "url" column sets the start URL. Wins over URLs.`
              : "CSV (header row → variable names) or a JSON array of objects. One parallel run per row."}
          </p>
        </div>
      )}
    </div>
  );
}

/** Parse the matrix textarea into variable rows: a JSON array of objects, or CSV
 *  (first line = headers). Simple comma CSV — fine for app/task/version/sha/url. */
function parseRows(text: string): Record<string, string>[] {
  const t = text.trim();
  if (!t) return [];
  if (t[0] === "[" || t[0] === "{") {
    try {
      const parsed = JSON.parse(t);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? "" : String(v)])));
    } catch {
      return [];
    }
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) row[h] = cells[i] ?? "";
    });
    return row;
  });
}

/** The held-browser banner + run verdict, for a runner that's active for this view. */
export function RunPanel({ runner }: { runner: AutomationRunner }) {
  const { running, lastRun, heldOpen, closeHeld, results } = runner;
  if (!running && !lastRun && !heldOpen) return null;
  return (
    <div className="space-y-2">
      {heldOpen && (
        <Alert
          tone={lastRun?.status === "failed" ? "error" : "info"}
          actions={
            <button
              type="button"
              onClick={closeHeld}
              className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-black/5 dark:border-gray-600 dark:hover:bg-white/10"
            >
              Close browser
            </button>
          }
        >
          {lastRun?.status === "failed"
            ? "A step failed — the browser was left open so you can inspect the page that broke."
            : "The browser was kept open so you can inspect the page."}
        </Alert>
      )}
      {(running || lastRun) && <RunSummary running={running} run={lastRun} />}
      {(running || lastRun) && <RunStepLog running={running} results={results} run={lastRun} />}
    </div>
  );
}
