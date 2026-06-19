import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
  deleteSetupScript,
  fetchSetupScript,
  fetchSetupScripts,
  resetSetupScript,
  saveSetupScript,
  seedSetupScripts,
  type SetupScriptDoc,
} from "../../api";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, FIELD_CLASS, OpenPathButton, Tooltip } from "../../components";
import { useConfirm } from "../../confirm";
import { useToast } from "../../toast";

/**
 * Admin: view + edit the "reset from scratch" setup scripts under
 * `~/.rubato/setup-scripts/` (ollama, miniconda, fooocus, the orchestrator, AWS
 * SES/EC2, Cloudflare, and the rubato/ca clones). These live OUTSIDE git; the repo
 * ships sanitized templates that are seeded here on first view. The panel shows each
 * file's absolute path so you can open it in your editor, and edits write straight to
 * disk. Only the Admin surface (gated by `ui.admin`) exposes these.
 */
export function SetupScriptsPanel() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { data: scripts = [] } = useQuery({ queryKey: ["setup-scripts"], queryFn: fetchSetupScripts });

  const [selected, setSelected] = useState<string | null>(null);
  // Default to the first script once the list loads (or after a delete clears it).
  const active = useMemo(() => {
    if (selected && scripts.some((s) => s.name === selected)) return selected;
    return scripts[0]?.name ?? null;
  }, [selected, scripts]);

  const { data, isLoading } = useQuery({
    queryKey: ["setup-script", active],
    queryFn: () => fetchSetupScript(active as string),
    enabled: active !== null,
  });

  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const isMarkdown = !!active?.endsWith(".md");
  // Re-seed the editor whenever the loaded script changes (selection / after save/reset).
  useEffect(() => {
    if (data) setDraft(data.content);
  }, [data]);
  useEffect(() => {
    if (!isMarkdown) setPreview(false);
  }, [isMarkdown]);

  const onSaved = (doc: SetupScriptDoc) => {
    qc.setQueryData(["setup-script", doc.name], doc);
    qc.invalidateQueries({ queryKey: ["setup-scripts"] });
  };

  const save = useMutation({
    mutationFn: (content: string) => saveSetupScript(active as string, content),
    onSuccess: (doc) => {
      notify("Saved", "success");
      onSaved(doc);
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const reset = useMutation({
    mutationFn: () => resetSetupScript(active as string),
    onSuccess: (doc) => {
      notify("Restored to default", "success");
      onSaved(doc);
    },
    onError: (e) => notify(e instanceof Error ? e.message : "restore failed", "error"),
  });

  const seed = useMutation({
    mutationFn: seedSetupScripts,
    onSuccess: ({ created }) => {
      notify(created.length ? `Restored ${created.length} default script(s)` : "All defaults already present", "success");
      qc.invalidateQueries({ queryKey: ["setup-scripts"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "seed failed", "error"),
  });

  const del = useMutation({
    mutationFn: (name: string) => deleteSetupScript(name),
    onSuccess: (_v, name) => {
      notify("Deleted", "success");
      qc.removeQueries({ queryKey: ["setup-script", name] });
      qc.invalidateQueries({ queryKey: ["setup-scripts"] });
      setSelected(null);
    },
    onError: (e) => notify(e instanceof Error ? e.message : "delete failed", "error"),
  });

  const dirty = data !== undefined && draft !== data.content;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-gray-500">
          Reset/provision scripts under <code>~/.rubato/setup-scripts/</code> — outside git, admin-only. Edits write
          straight to disk; open a file at its path to run it locally.
        </p>
        <Tooltip multiline content="Re-create any default scripts you've deleted. Never overwrites a script that already exists, so your edits are safe.">
          <button type="button" onClick={() => seed.mutate()} disabled={seed.isPending} className={`${BTN_GHOST_CLASS} ml-auto`}>
            {seed.isPending ? "Restoring…" : "Restore defaults"}
          </button>
        </Tooltip>
      </div>

      {scripts.length === 0 ? (
        <p className="text-gray-400">No setup scripts yet — click “Restore defaults” to seed them.</p>
      ) : (
        <div className="flex gap-4">
          <ul className="flex max-h-[30rem] w-60 shrink-0 flex-col gap-1 overflow-auto">
            {scripts.map((s) => (
              <li key={s.name}>
                <Tooltip multiline content={s.description ? `${s.description}\n${s.path}` : s.path}>
                  <button
                    type="button"
                    onClick={() => setSelected(s.name)}
                    className={`w-full rounded-lg px-3 py-1.5 text-left transition-colors ${
                      s.name === active ? "bg-accent-soft" : "hover:bg-gray-100 dark:hover:bg-gray-800"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate text-sm font-medium">{s.label}</span>
                      {!s.isTemplate && (
                        <span className="shrink-0 rounded bg-gray-100 px-1 text-[10px] text-gray-500 dark:bg-gray-800">custom</span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-gray-400">{s.name}</div>
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>

          <section className="flex min-w-0 flex-1 flex-col">
            {!data ? (
              <p className="text-gray-400">{isLoading ? "loading…" : "Select a script to view it."}</p>
            ) : (
              <>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-xs text-gray-500">{data.path}</span>
                  <OpenPathButton path={data.path} />
                  {dirty && <span className="text-xs text-accent">• unsaved changes</span>}
                  <div className="ml-auto flex items-center gap-1.5">
                    {isMarkdown && (
                      <button type="button" onClick={() => setPreview((p) => !p)} className={BTN_GHOST_CLASS}>
                        {preview ? "Edit" : "Preview"}
                      </button>
                    )}
                    {data.isTemplate && (
                      <Tooltip multiline content="Overwrite this file with rubato's bundled default template, discarding your edits.">
                        <button
                          type="button"
                          onClick={async () => {
                            if (
                              await confirm({
                                prompt: `Restore ${data.name} to its default template? This discards your edits.`,
                                confirmText: "Restore",
                              })
                            )
                              reset.mutate();
                          }}
                          disabled={reset.isPending}
                          className={BTN_GHOST_CLASS}
                        >
                          Reset to default
                        </button>
                      </Tooltip>
                    )}
                    <button
                      type="button"
                      onClick={async () => {
                        if (
                          await confirm({
                            prompt: `Delete ${data.name}? ${
                              data.isTemplate ? "You can restore it with “Restore defaults”." : "This cannot be undone."
                            }`,
                            confirmText: "Delete",
                          })
                        )
                          del.mutate(data.name);
                      }}
                      disabled={del.isPending}
                      className={BTN_GHOST_CLASS}
                    >
                      Delete
                    </button>
                    <Tooltip multiline content="Write your edits straight to this file on disk at its real path. Takes effect the next time you run it.">
                      <button
                        type="button"
                        onClick={() => save.mutate(draft)}
                        disabled={!dirty || save.isPending}
                        className={BTN_PRIMARY_CLASS}
                      >
                        {save.isPending ? "Saving…" : "Save"}
                      </button>
                    </Tooltip>
                  </div>
                </div>

                {preview && isMarkdown ? (
                  <article className="chat-md max-h-[30rem] min-h-0 flex-1 overflow-auto rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
                    {draft.trim() ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {draft}
                      </ReactMarkdown>
                    ) : (
                      <p className="text-gray-400">Nothing to preview.</p>
                    )}
                  </article>
                ) : (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    placeholder="(empty)"
                    className={`h-[30rem] min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed ${FIELD_CLASS}`}
                  />
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
