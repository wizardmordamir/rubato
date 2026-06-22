import { useMutation, useQuery } from "@tanstack/react-query";
import { CopyButton } from "cursedbelt/react";
import { useEffect, useMemo, useState } from "react";
import {
  buildSplunkQuery,
  fetchSplunkApps,
  fetchSplunkStatus,
  runSplunkSearch,
  type SplunkQueryRequest,
  type SplunkRunResponse,
} from "../api";
import {
  Badge,
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  FIELD_CLASS,
  OpenPathButton,
  PageHeading,
  PathRef,
  Tooltip,
} from "../components";
import { ResultView } from "../result/ResultView";
import { tableFromRecords } from "../result/table";
import { useToast } from "../toast";

/** Sentinel "app" value for an ad-hoc query unrelated to any configured app. */
const CUSTOM = "__custom__";

/**
 * Splunk query builder — pick an app/env/saved-search, fill a couple of blanks,
 * and copy the assembled query. The templates live in each app's `splunk` config
 * (read server-side), so the query is built by the server as the inputs change.
 * When Splunk keys are configured (GET /api/splunk/status), a Run button also
 * executes the query and shows the result rows.
 *
 * Picking **Custom (no app)** builds an app-less query from global defaults + the
 * inline fields alone — for ad-hoc SPL not tied to a registered app. There the
 * domain field is taken literally (blank = no `dom IN(...)` filter) and an App ID
 * box supplies `${app}` should the domain/fragment reference it.
 */
export function SplunkPage() {
  const { notify } = useToast();
  const { data: apps = [], isLoading } = useQuery({ queryKey: ["splunk-apps"], queryFn: fetchSplunkApps });
  const { data: status } = useQuery({ queryKey: ["splunk-status"], queryFn: fetchSplunkStatus });

  const [app, setApp] = useState("");
  const [appId, setAppId] = useState("");
  const [env, setEnv] = useState("");
  const [search, setSearch] = useState("");
  const [extra, setExtra] = useState("");
  const [index, setIndex] = useState("");
  const [domain, setDomain] = useState("");
  const [fragment, setFragment] = useState("");
  const [earliest, setEarliest] = useState("-24h");
  const [results, setResults] = useState<SplunkRunResponse | null>(null);

  // Default to the first app once loaded; fall back to Custom when none are configured.
  useEffect(() => {
    if (app) return;
    setApp(apps.length ? apps[0].app : CUSTOM);
  }, [apps, app]);

  const isCustom = app === CUSTOM;
  const current = useMemo(() => apps.find((a) => a.app === app), [apps, app]);

  // Reset env/search/overrides when the app changes (defaults pulled from the new app).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on app switch
  useEffect(() => {
    setEnv(current?.envs[0] ?? "");
    setSearch("");
    setIndex("");
    setDomain("");
    setFragment("");
    setAppId("");
  }, [app]);

  const selectedSearch = current?.searches.find((s) => s.label === search);

  // Drop stale results once the query changes (they belong to the old query).
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear on any input change
  useEffect(() => setResults(null), [app, appId, env, search, extra, index, domain, fragment, earliest]);

  // Assemble the request the build + run share. Custom mode sends no `app` (uses
  // global defaults only) and passes `domain` literally so blank means "no filter".
  const makeRequest = (): SplunkQueryRequest => ({
    app: isCustom ? undefined : app,
    appId: isCustom ? appId || undefined : undefined,
    env: env || undefined,
    search: search || undefined,
    extra: extra || undefined,
    index: index || undefined,
    domain: isCustom ? domain : domain || undefined,
    fragment: fragment || undefined,
  });

  const { data: built } = useQuery({
    queryKey: ["splunk-query", app, appId, env, search, extra, index, domain, fragment],
    queryFn: () => buildSplunkQuery(makeRequest()),
    enabled: !!app,
    placeholderData: (prev) => prev,
  });

  const run = useMutation({
    mutationFn: () => runSplunkSearch({ ...makeRequest(), earliest: earliest || undefined }),
    onSuccess: (r) => {
      setResults(r);
      notify(`${r.count} ${r.count === 1 ? "row" : "rows"}`, "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "run failed", "error"),
  });

  const canRun = status?.configured && built?.query && !built.missing.length;
  const defaultEnvs = status?.defaults?.envs ?? [];

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div>
      <PageHeading title="Splunk" count={apps.length} />
      <p className="mb-4 text-xs text-gray-400">
        Build a Splunk search from an app's saved templates — or pick <strong>Custom</strong> for an ad-hoc query
        unrelated to any app. Fill the blanks and copy.
      </p>

      {apps.length === 0 ? <EmptyState /> : null}

      {(current || isCustom) && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="App">
              <select className={FIELD_CLASS} value={app} onChange={(e) => setApp(e.target.value)}>
                {apps.map((a) => (
                  <option key={a.app} value={a.app}>
                    {a.app}
                  </option>
                ))}
                <option value={CUSTOM}>Custom (no app)</option>
              </select>
            </Field>

            <Field label="Environment">
              {current?.envs.length ? (
                <select className={FIELD_CLASS} value={env} onChange={(e) => setEnv(e.target.value)}>
                  {current.envs.map((ev) => (
                    <option key={ev} value={ev}>
                      {ev}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    className={FIELD_CLASS}
                    value={env}
                    onChange={(e) => setEnv(e.target.value)}
                    placeholder="prod"
                    list={defaultEnvs.length ? "splunk-envs" : undefined}
                  />
                  {defaultEnvs.length > 0 && (
                    <datalist id="splunk-envs">
                      {defaultEnvs.map((ev) => (
                        <option key={ev} value={ev} />
                      ))}
                    </datalist>
                  )}
                </>
              )}
            </Field>

            {isCustom ? (
              <Field label="App ID">
                <input
                  className={FIELD_CLASS}
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="fills ${app} (optional)"
                />
              </Field>
            ) : (
              current &&
              current.searches.length > 0 && (
                <Field label="Saved search">
                  <select className={FIELD_CLASS} value={search} onChange={(e) => setSearch(e.target.value)}>
                    <option value="">— none —</option>
                    {current.searches.map((s) => (
                      <option key={s.label} value={s.label}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )
            )}

            <Field label="Extra terms">
              <input
                className={FIELD_CLASS}
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder="| stats count by status"
              />
            </Field>
          </div>

          <details className="text-sm" open={isCustom}>
            <summary className="cursor-pointer text-xs text-gray-500 hover:text-accent">
              {isCustom ? "Query parts" : "Overrides"}
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <Field label="Index">
                <input
                  className={FIELD_CLASS}
                  value={index}
                  onChange={(e) => setIndex(e.target.value)}
                  placeholder={current?.index ?? status?.defaults?.index ?? "main"}
                />
              </Field>
              <Field label="Domain pattern">
                <input
                  className={FIELD_CLASS}
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder={isCustom ? "${app}-${env} (blank = none)" : status?.defaults?.domain ?? "${app}-${env}"}
                />
              </Field>
              <Field label="Search fragment">
                <input
                  className={FIELD_CLASS}
                  value={fragment}
                  onChange={(e) => setFragment(e.target.value)}
                  placeholder={selectedSearch?.search ?? "/api/v*/audit"}
                />
              </Field>
            </div>
          </details>

          <div className={`${CARD_CLASS} p-4`}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-gray-500">Query</span>
              {built?.missing?.length ? <Badge tone="error">missing: {built.missing.join(", ")}</Badge> : null}
              <div className="ml-auto flex items-center gap-2">
                {status?.configured && (
                  <label className="flex items-center gap-1 text-xs text-gray-500">
                    last
                    <Tooltip content="Search window start (Splunk time syntax)">
                      <input
                        className={`${FIELD_CLASS} w-24 py-1`}
                        value={earliest}
                        onChange={(e) => setEarliest(e.target.value)}
                        placeholder="-24h"
                      />
                    </Tooltip>
                  </label>
                )}
                <CopyButton
                  text={built?.query ?? ""}
                  disabled={!built?.query}
                  className={BTN_GHOST_CLASS}
                  onCopied={() => notify("Query copied", "success")}
                >
                  Copy
                </CopyButton>
                {status?.configured && (
                  <button
                    type="button"
                    onClick={() => run.mutate()}
                    disabled={!canRun || run.isPending}
                    className={BTN_PRIMARY_CLASS}
                  >
                    {run.isPending ? "Running…" : "Run"}
                  </button>
                )}
              </div>
            </div>
            <pre className="overflow-auto rounded-lg bg-gray-100 p-3 font-mono text-sm whitespace-pre-wrap dark:bg-gray-800/60">
              {built?.query || <span className="text-gray-400">…</span>}
            </pre>
            {!status?.configured && (
              <p className="mt-2 text-xs text-gray-400">
                Set <code>SPLUNK_URL</code> + <code>SPLUNK_TOKEN</code> in <code>~/.rubato/.env</code>
                <OpenPathButton path="~/.rubato/.env" /> to run searches here (otherwise copy the query into Splunk).
              </p>
            )}
          </div>

          {results && <SplunkResults results={results} />}
        </div>
      )}
    </div>
  );
}

/** Splunk run results as a Grid / JSON / CSV switcher (the fields are the columns). */
function SplunkResults({ results }: { results: SplunkRunResponse }) {
  if (results.count === 0) {
    return <p className="text-sm text-gray-400">No results in this time range.</p>;
  }
  return (
    <ResultView
      json={results.rows}
      table={tableFromRecords(results.rows, results.fields)}
      count={results.count}
      filename="splunk-results"
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-500">{label}</span>
      {children}
    </label>
  );
}

function EmptyState() {
  return (
    <div className={`${CARD_CLASS} mb-4 p-4 text-sm text-gray-500`}>
      <p className="mb-2">
        No apps have a Splunk config yet — you can still build a <strong>Custom (no app)</strong> query below. To wire up
        an app, add an <code>apis</code> entry to it in <PathRef path="~/.rubato/apps.json" />:
      </p>
      <pre className="overflow-auto rounded-lg bg-gray-100 p-3 font-mono text-xs whitespace-pre dark:bg-gray-800/60">
        {`"apis": [
  {
    "name": "splunk",
    "index": "main",
    "envs": ["dev", "test", "prod"],
    "searches": [
      { "label": "Audit logs", "search": "/api/v*/audit" }
    ]
  }
]`}
      </pre>
      <p className="mt-2">
        Global defaults (a shared index, the <code>{"dom IN(...)"}</code> shape) go under <code>splunk</code> in{" "}
        <code>~/.rubato/config.json</code>
        <OpenPathButton path="~/.rubato/config.json" />. <a className={BTN_GHOST_CLASS} href="/docs/rubato">Docs</a>
      </p>
    </div>
  );
}
