import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { JsonEditor } from "cwip/react";
import { useEffect, useState } from "react";
import { fetchConfig, saveConfig } from "../api";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, OpenPathButton, PageHeading, Tooltip } from "../components";
import { useToast } from "../toast";

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
  // Seed the editor from the loaded config whenever it (re)loads and we're not
  // mid-edit, so an external change or a save shows through.
  useEffect(() => {
    if (!editing) setDraft(serialized);
  }, [serialized, editing]);

  const save = useMutation({
    mutationFn: (content: string) => saveConfig(content),
    onSuccess: (cfg) => {
      qc.setQueryData(["config"], cfg);
      qc.invalidateQueries({ queryKey: ["ui"] }); // page toggles etc. may have changed
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
      <p className="mb-3 text-xs text-gray-500">
        From <span className="font-mono">~/.rubato/config.json</span>
        <OpenPathButton path="~/.rubato/config.json" /> (secrets live in
        <span className="font-mono"> ~/.rubato/.env</span>
        <OpenPathButton path="~/.rubato/.env" /> and are never served).
      </p>
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
