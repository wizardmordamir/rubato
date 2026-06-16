import { useQuery } from "@tanstack/react-query";
import { EnvCompare } from "cwip/react";
import { useMemo, useState } from "react";
import type { EnvDiscoveryMode, EnvDiscoveryResult } from "@shared/envDiscovery";
import { fetchAppEnvFile, fetchAppEnvFiles, fetchApps, fetchEnvDiscovery } from "../api";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, PageHeading } from "../components";
import { useToast } from "../toast";

interface Column {
  id: string;
  label: string;
  text: string;
}

/** One app:file the compare grid can load. */
interface EnvPair {
  app: string;
  path: string;
}

/** Function that loads many app:file pairs into the compare grid; resolves to # newly added. */
type AddColumns = (pairs: EnvPair[]) => Promise<number>;

/**
 * Edit (on app detail), compare, and SEARCH .env files across apps:
 * - **Search** finds which apps have (or lack) a given key/value — by group or
 *   across every config that carries `.env*` files. Results show key NAMES only
 *   (no values) and each (or all at once) can be added straight into the compare
 *   grid below.
 * - **Compare** shows the picked files' values in a key×source grid (cwip's
 *   EnvCompare) to spot a missing key or a stale/different value — across a single
 *   app, a whole **group** (the containing folder), or every app. Values masked by
 *   default.
 */
export function EnvComparePage() {
  const { notify } = useToast();
  const { data: apps = [] } = useQuery({ queryKey: ["apps"], queryFn: fetchApps });
  const [appName, setAppName] = useState("");
  const [path, setPath] = useState("");
  const [columns, setColumns] = useState<Column[]>([]);
  const [adding, setAdding] = useState(false);

  const groups = useMemo(
    () => [...new Set(apps.map((a) => a.group).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b)),
    [apps],
  );

  const { data: files = [] } = useQuery({
    queryKey: ["app-env-files", appName],
    queryFn: () => fetchAppEnvFiles(appName),
    enabled: !!appName,
  });

  /**
   * Load many app:file pairs in parallel and add them as compare columns (deduped
   * against what's already shown and within the batch). Returns how many were newly
   * added. The single-file `addColumn` is just the one-pair case.
   */
  const addColumns: AddColumns = async (pairs) => {
    const seen = new Set<string>();
    const wanted = pairs.filter(({ app, path: p }) => {
      const id = `${app}:${p}`;
      if (seen.has(id) || columns.some((c) => c.id === id)) return false;
      seen.add(id);
      return true;
    });
    if (wanted.length === 0) return 0;
    const loaded = await Promise.all(
      wanted.map(async ({ app, path: p }) => {
        const res = await fetchAppEnvFile(app, p);
        const id = `${app}:${p}`;
        return { id, label: id, text: res.content };
      }),
    );
    // Re-dedup inside the functional update in case state moved under us.
    setColumns((cols) => {
      const have = new Set(cols.map((c) => c.id));
      return [...cols, ...loaded.filter((c) => !have.has(c.id))];
    });
    return loaded.length;
  };

  const addColumn = (app: string, p: string) => addColumns([{ app, path: p }]);

  const add = async () => {
    if (!appName || !path) return;
    setAdding(true);
    try {
      await addColumn(appName, path);
      setPath("");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Failed to load file");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <PageHeading title="Env Files" />
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        Search, compare, and (on each app's detail page) edit `.env*` files across your apps. Search finds which configs
        have or lack a key; compare lines up their values — a single file, a whole group, or every app — so a missing
        key or a stale value jumps out. Values stay hidden until revealed.
      </p>

      <EnvSearchSection groups={groups} onCompare={addColumn} onCompareMany={addColumns} notify={notify} />

      <section className={`${CARD_CLASS} mt-4 p-4`}>
        <h2 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">Compare files side by side</h2>

        <GroupAddRow groups={groups} addColumns={addColumns} notify={notify} />

        <div className="mb-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            App
            <select
              className={FIELD_CLASS}
              style={{ minWidth: 180 }}
              value={appName}
              onChange={(e) => {
                setAppName(e.target.value);
                setPath("");
              }}
            >
              <option value="">Select app…</option>
              {[...apps]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-500">
            File
            <select
              className={FIELD_CLASS}
              style={{ minWidth: 200 }}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              disabled={!appName}
            >
              <option value="">
                {appName ? (files.length ? "Select file…" : "no .env files") : "pick an app first"}
              </option>
              {files.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={BTN_PRIMARY_CLASS} disabled={!appName || !path || adding} onClick={add}>
            {adding ? "Adding…" : "Add column"}
          </button>
        </div>

        {columns.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {columns.map((c) => (
              <span
                key={c.id}
                className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-800"
              >
                {c.label}
                <button
                  type="button"
                  aria-label={`Remove ${c.label}`}
                  className="text-gray-400 hover:text-rose-500"
                  onClick={() => setColumns((cols) => cols.filter((x) => x.id !== c.id))}
                >
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              className="ml-1 text-xs text-gray-400 underline hover:text-rose-500"
              onClick={() => setColumns([])}
            >
              Clear all
            </button>
          </div>
        )}

        {columns.length === 0 ? (
          <p className="text-sm text-gray-400">
            Add a whole group (or every app) above, pick a single file, or use a search result's “Compare”.
          </p>
        ) : (
          <EnvCompare
            sources={columns.map((c) => ({ label: c.label, text: c.text }))}
            onCopied={() => notify("Copied")}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Bulk-load every `.env*` file in a group (or across all apps) into the compare
 * grid in one click — the "is this field in all the right .env files?" flow for a
 * folder full of apps. An optional filename filter narrows to e.g. just `.env`
 * (not `.env.sample`) when apps carry several.
 */
function GroupAddRow({
  groups,
  addColumns,
  notify,
}: {
  groups: string[];
  addColumns: AddColumns;
  notify: (msg: string) => void;
}) {
  const [group, setGroup] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchEnvDiscovery({ group, mode: "all" });
      const needle = filter.trim().toLowerCase();
      const pairs = res.apps.flatMap((a) =>
        a.files
          .filter((f) => !needle || f.path.toLowerCase().includes(needle))
          .map((f) => ({ app: a.name, path: f.path })),
      );
      if (pairs.length === 0) {
        notify(needle ? `No .env files match “${filter}” in that scope` : "No .env files in that scope");
        return;
      }
      const added = await addColumns(pairs);
      notify(added ? `Added ${added} file${added === 1 ? "" : "s"} to compare` : "Those files are already in the grid");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Failed to load group");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-gray-200 p-3 dark:border-gray-700">
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        Add a whole group
        <select className={FIELD_CLASS} style={{ minWidth: 180 }} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">All apps</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        File name filter (optional)
        <input
          className={FIELD_CLASS}
          style={{ minWidth: 160 }}
          placeholder="e.g. .env (blank = all .env*)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
      <button type="button" className={BTN_GHOST_CLASS} disabled={loading} onClick={load}>
        {loading ? "Loading…" : group ? `Add “${group}” to compare` : "Add all apps to compare"}
      </button>
    </div>
  );
}

/** "Which apps have (or lack) this key?" — searches `.env*` across every app. */
function EnvSearchSection({
  groups,
  onCompare,
  onCompareMany,
  notify,
}: {
  groups: string[];
  onCompare: (app: string, path: string) => Promise<number>;
  onCompareMany: AddColumns;
  notify: (msg: string) => void;
}) {
  const [q, setQ] = useState("");
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<EnvDiscoveryMode>("with");
  const [group, setGroup] = useState("");
  const [result, setResult] = useState<EnvDiscoveryResult | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      setResult(await fetchEnvDiscovery({ q, value, mode, group }));
    } catch (e) {
      notify(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={`${CARD_CLASS} p-4`}>
      <h2 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">Search keys across all apps</h2>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Key contains
          <input
            className={FIELD_CLASS}
            style={{ minWidth: 160 }}
            placeholder="e.g. API_TOKEN"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Value contains (optional)
          <input
            className={FIELD_CLASS}
            style={{ minWidth: 140 }}
            placeholder="any value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Show
          <select className={FIELD_CLASS} value={mode} onChange={(e) => setMode(e.target.value as EnvDiscoveryMode)}>
            <option value="with">apps that HAVE it</option>
            <option value="without">apps that LACK it</option>
            <option value="all">all (highlight matches)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-500">
          Group
          <select className={FIELD_CLASS} value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">all groups</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={BTN_PRIMARY_CLASS} disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {result && <EnvSearchResults result={result} onCompare={onCompare} onCompareMany={onCompareMany} notify={notify} />}
    </section>
  );
}

function EnvSearchResults({
  result,
  onCompare,
  onCompareMany,
  notify,
}: {
  result: EnvDiscoveryResult;
  onCompare: (app: string, path: string) => Promise<number>;
  onCompareMany: AddColumns;
  notify: (msg: string) => void;
}) {
  const searching = result.query !== "" || result.value !== "";
  const allPairs = result.apps.flatMap((a) => a.files.map((f) => ({ app: a.name, path: f.path })));

  const compare = async (app: string, path: string) => {
    try {
      await onCompare(app, path);
      notify(`Added ${app}:${path} to compare`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Failed to load file");
    }
  };

  const compareAll = async () => {
    try {
      const added = await onCompareMany(allPairs);
      notify(added ? `Added ${added} file${added === 1 ? "" : "s"} to compare` : "Those files are already in the grid");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Failed to load files");
    }
  };

  return (
    <div className="mt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-xs text-gray-500">
          {searching ? (
            <>
              <span className="font-medium text-gray-700 dark:text-gray-200">{result.matchedApps}</span> of{" "}
              {result.scannedApps} app(s) with `.env*` files {result.mode === "without" ? "lack" : "match"} your search.
            </>
          ) : (
            <>
              <span className="font-medium text-gray-700 dark:text-gray-200">{result.scannedApps}</span> app(s) carry
              `.env*` files.
            </>
          )}
        </p>
        {allPairs.length > 0 && (
          <button type="button" className={`${BTN_GHOST_CLASS} ml-auto px-2 py-0.5 text-xs`} onClick={compareAll}>
            Add all {allPairs.length} to compare
          </button>
        )}
      </div>
      {result.apps.length === 0 ? (
        <p className="text-sm text-gray-400">No matching configs.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {result.apps.map((app) => (
            <li key={app.name} className="rounded-lg border border-gray-200 p-2 dark:border-gray-800">
              <div className="mb-1 flex items-center gap-2 text-sm">
                <span className="font-medium">{app.name}</span>
                {app.group && (
                  <span className="rounded bg-gray-100 px-1.5 text-xs text-gray-500 dark:bg-gray-800">{app.group}</span>
                )}
              </div>
              <ul className="flex flex-col gap-1">
                {app.files.map((f) => (
                  <li key={f.path} className="flex flex-wrap items-center gap-2 text-xs">
                    <code className="rounded bg-gray-50 px-1 dark:bg-gray-900">{f.path}</code>
                    <span className="text-gray-400">{f.keyCount} keys</span>
                    {f.matchedKeys.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {f.matchedKeys.map((k) => (
                          <span
                            key={k}
                            className="rounded bg-emerald-100 px-1 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                          >
                            {k}
                          </span>
                        ))}
                      </span>
                    )}
                    {searching && result.mode === "without" && (
                      <span className="text-amber-600 dark:text-amber-400">— lacks it —</span>
                    )}
                    <button
                      type="button"
                      className={`${BTN_GHOST_CLASS} ml-auto px-2 py-0.5 text-xs`}
                      onClick={() => compare(app.name, f.path)}
                    >
                      Compare
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
