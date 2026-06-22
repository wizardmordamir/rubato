import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { JsonEditor } from "cursedbelt/react";
import { useEffect, useState } from "react";
import { browseDir, type BrowseDirResult, fetchConfig, runAppsScan, saveConfig, setCodeDirs, type ScanResult } from "../api";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, FIELD_CLASS, OpenPathButton, PageHeading, Tooltip } from "../components";
import { Modal } from "../Modal";
import { useToast } from "../toast";

function scanSummary(res: ScanResult): string {
  const parts: string[] = [];
  if (res.newApps.length) parts.push(`${res.newApps.length} new`);
  if (res.updatedCount) parts.push(`${res.updatedCount} updated`);
  if (res.missingApps.length) parts.push(`${res.missingApps.length} missing`);
  if (res.removedCount) parts.push(`${res.removedCount} removed`);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  return `Scanned ${res.reposFound} repos${detail}`;
}

function FolderPickerModal({ onClose, onPick }: { onClose: () => void; onPick: (path: string) => void }) {
  const { notify } = useToast();
  const [current, setCurrent] = useState<BrowseDirResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [pathInput, setPathInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);

  const load = async (path: string) => {
    setLoading(true);
    try {
      const result = await browseDir(path);
      setCurrent(result);
      setPathInput(result.path);
    } catch (e) {
      notify(e instanceof Error ? e.message : "could not read directory");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(""); }, []);

  return (
    <Modal title="Choose a scan root" onClose={onClose} widthClass="max-w-xl">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <button type="button" className={BTN_GHOST_CLASS} onClick={() => load(current?.home ?? "")} disabled={loading} title="Home">~</button>
          <button
            type="button"
            className={BTN_GHOST_CLASS}
            onClick={() => current && load(current.path.replace(/\/[^/]+$/, "") || "/")}
            disabled={loading || !current || current.path === "/"}
            title="Up"
          >↑</button>
          <input
            className={`${FIELD_CLASS} flex-1 font-mono text-xs`}
            value={inputFocused ? pathInput : (current?.path ?? "")}
            onChange={(e) => setPathInput(e.target.value)}
            onFocus={() => { setInputFocused(true); setPathInput(current?.path ?? ""); }}
            onBlur={() => setInputFocused(false)}
            onKeyDown={(e) => { if (e.key === "Enter") { load(pathInput); setInputFocused(false); } }}
            placeholder="Type a path and press Enter"
            spellCheck={false}
          />
        </div>
        <div className="max-h-56 overflow-auto rounded border border-gray-200 dark:border-gray-700">
          {loading ? (
            <p className="p-3 text-xs text-gray-400">Loading…</p>
          ) : !current || current.dirs.length === 0 ? (
            <p className="p-3 text-xs text-gray-400">No subdirectories</p>
          ) : (
            <ul>
              {current.dirs.map((dir) => (
                <li key={dir}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                    onClick={() => load(`${current.path}/${dir}`)}
                  >
                    <span className="text-gray-400">📁</span>
                    <span className="font-mono">{dir}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
          <span className="flex-1 truncate font-mono text-xs text-gray-500">{current?.path ?? "…"}</span>
          <button type="button" className={BTN_PRIMARY_CLASS} disabled={!current} onClick={() => current && onPick(current.path)}>
            Select
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Structured panel for editing the `codeDirs` scan roots — add/remove paths,
 * run a full recursive scan. Sits above the raw JSON editor so it's usable
 * without knowing the config schema.
 */
function CodeDirsPanel({ codeDirs, onChange }: { codeDirs: string[]; onChange: () => void }) {
  const { notify } = useToast();
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const save = useMutation({
    mutationFn: (dirs: string[]) => setCodeDirs(dirs),
    onSuccess: () => {
      onChange();
      qc.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed"),
  });

  const scan = useMutation({
    mutationFn: () => runAppsScan(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["apps"] });
      notify(scanSummary(res));
    },
    onError: (e) => notify(e instanceof Error ? e.message : "scan failed"),
  });

  const remove = (dir: string) => save.mutate(codeDirs.filter((d) => d !== dir));

  const pick = (path: string) => {
    setPickerOpen(false);
    if (!codeDirs.includes(path)) save.mutate([...codeDirs, path]);
    else notify(`${path} is already a scan root`);
  };

  return (
    <div className="mb-6 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
      {pickerOpen && <FolderPickerModal onClose={() => setPickerOpen(false)} onPick={pick} />}
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          Scan roots <span className="ml-1 text-xs font-normal text-gray-400">codeDirs</span>
        </h3>
        <div className="flex gap-2">
          <Tooltip content="Browse your filesystem to add a directory as a scan root">
            <button type="button" className={BTN_GHOST_CLASS} onClick={() => setPickerOpen(true)}>
              + Add root…
            </button>
          </Tooltip>
          <Tooltip
            multiline
            content="Recursively scan all roots for git repos and merge them into the app registry. Same as running `rubato-scan` in the terminal."
          >
            <button
              type="button"
              className={BTN_PRIMARY_CLASS}
              disabled={scan.isPending || codeDirs.length === 0}
              onClick={() => scan.mutate()}
            >
              {scan.isPending ? "Scanning…" : "Run scan"}
            </button>
          </Tooltip>
        </div>
      </div>
      <p className="mb-3 text-xs text-gray-500">
        rubato-scan recursively walks each root (up to depth 6) looking for git repos and registers them as
        apps. Worktrees, submodules, and <span className="font-mono">node_modules</span> are skipped.
        Also configurable via <span className="font-mono">codeDirs</span> in the JSON below.
      </p>
      {codeDirs.length === 0 ? (
        <p className="text-xs text-gray-400">No scan roots configured — add one above.</p>
      ) : (
        <ul className="space-y-1">
          {codeDirs.map((dir) => (
            <li key={dir} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-1.5 dark:bg-gray-800">
              <span className="flex-1 truncate font-mono text-xs">{dir}</span>
              <button
                type="button"
                className="text-xs text-gray-400 transition-colors hover:text-red-500"
                onClick={() => remove(dir)}
                disabled={save.isPending}
                title="Remove scan root"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * View + edit `~/.rubato/config.json`. Read-only by default (a plain JSON view);
 * "Edit" swaps in the shared cwip <JsonEditor> (tolerant JSON/JS, live validity, a
 * Format button) and Save writes the whole file via `POST /api/config`. Secrets
 * live in `~/.rubato/.env` and are never served here.
 */
export function ConfigPage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const { data, isLoading } = useQuery({ queryKey: ["config"], queryFn: fetchConfig });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const serialized = data ? JSON.stringify(data, null, 2) : "";
  useEffect(() => {
    if (!editing) setDraft(serialized);
  }, [serialized, editing]);

  const codeDirs: string[] = Array.isArray((data as Record<string, unknown> | undefined)?.codeDirs)
    ? ((data as Record<string, unknown>).codeDirs as string[])
    : [];

  const save = useMutation({
    mutationFn: (content: string) => saveConfig(content),
    onSuccess: (cfg) => {
      qc.setQueryData(["config"], cfg);
      qc.invalidateQueries({ queryKey: ["ui"] });
      setEditing(false);
      notify("Saved ~/.rubato/config.json", "success");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const dirty = editing && draft !== serialized;

  return (
    <div>
      <PageHeading
        title="Config"
        actions={
          editing ? (
            <>
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                onClick={() => {
                  setDraft(serialized);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
              <Tooltip
                multiline
                content="Writes this whole edited file to ~/.rubato/config.json on disk, replacing its current contents. Changes apply immediately and can affect the app (e.g. which pages are enabled). Secrets in ~/.rubato/.env are untouched."
              >
                <button
                  type="button"
                  className={BTN_PRIMARY_CLASS}
                  disabled={!dirty || save.isPending}
                  onClick={() => save.mutate(draft)}
                >
                  {save.isPending ? "Saving…" : "Save"}
                </button>
              </Tooltip>
            </>
          ) : (
            <button type="button" className={BTN_PRIMARY_CLASS} disabled={isLoading} onClick={() => setEditing(true)}>
              Edit
            </button>
          )
        }
      />
      <p className="mb-4 text-xs text-gray-500">
        From <span className="font-mono">~/.rubato/config.json</span>
        <OpenPathButton path="~/.rubato/config.json" /> (secrets live in
        <span className="font-mono"> ~/.rubato/.env</span>
        <OpenPathButton path="~/.rubato/.env" /> and are never served).
      </p>

      {!isLoading && (
        <CodeDirsPanel
          codeDirs={codeDirs}
          onChange={() => qc.invalidateQueries({ queryKey: ["config"] })}
        />
      )}

      {isLoading ? (
        <p className="text-gray-400">loading…</p>
      ) : editing ? (
        <JsonEditor value={draft} onChange={setDraft} rows={24} formatLabel="Format" />
      ) : (
        <pre className="overflow-auto rounded-xl border border-gray-200 bg-white p-3 font-mono text-xs dark:border-gray-800 dark:bg-gray-900">
          {serialized}
        </pre>
      )}
    </div>
  );
}
