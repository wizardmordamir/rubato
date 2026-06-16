import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useSearchParams } from "react-router-dom";
import { fetchSystemFile, fetchSystemFiles, saveSystemFile, type SystemFileDoc } from "../api";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, FIELD_CLASS, OpenPathButton, PageHeading, Tooltip } from "../components";
import { useToast } from "../toast";

/**
 * View + edit the user's common "system files" — the global Claude Code
 * instructions (`~/.claude/CLAUDE.md`), shell rc/profile files, and git config.
 * The editable set is a server allowlist (see `systemFiles.ts`); this page only
 * ever sends a stable `key`, never a path. A `?file=<key>` query param deep-links a
 * file (used by the back-compat `/claude-md` redirect). Saving creates the file if
 * it doesn't exist yet.
 */
export function SystemFilesPage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const [params, setParams] = useSearchParams();
  const { data: files = [] } = useQuery({ queryKey: ["system-files"], queryFn: fetchSystemFiles });

  // Selection: the ?file= param wins; else the first file once the list loads.
  const wanted = params.get("file");
  const selected = useMemo(() => {
    if (wanted && files.some((f) => f.key === wanted)) return wanted;
    return files[0]?.key ?? null;
  }, [wanted, files]);

  const select = (key: string) => setParams((p) => {
    p.set("file", key);
    return p;
  }, { replace: true });

  const { data, isLoading } = useQuery({
    queryKey: ["system-file", selected],
    queryFn: () => fetchSystemFile(selected as string),
    enabled: selected !== null,
  });

  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  // Seed the editor whenever the loaded file changes (selection / after a save).
  useEffect(() => {
    if (data) setDraft(data.content);
  }, [data]);
  // A non-markdown file has nothing to preview — drop back to edit when switching.
  useEffect(() => {
    if (data && !data.markdown) setPreview(false);
  }, [data]);

  const save = useMutation({
    mutationFn: (content: string) => saveSystemFile(selected as string, content),
    onSuccess: (doc: SystemFileDoc) => {
      notify("Saved", "success");
      qc.setQueryData(["system-file", doc.key], doc);
      qc.invalidateQueries({ queryKey: ["system-files"] }); // refresh exists dots
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const dirty = data !== undefined && draft !== data.content;

  return (
    <div className="flex h-full flex-col">
      <PageHeading
        title="System Files"
        actions={
          data?.markdown ? (
            <>
              <button type="button" onClick={() => setPreview((p) => !p)} className={BTN_GHOST_CLASS}>
                {preview ? "Edit" : "Preview"}
              </button>
              <Tooltip
                multiline
                content="Writes your edits straight to this file on disk at its real path (e.g. ~/.claude/CLAUDE.md, a shell rc, or git config), replacing its contents. If the file doesn't exist yet it's created. Takes effect the next time something reads it."
              >
                <button
                  type="button"
                  onClick={() => save.mutate(draft)}
                  disabled={!dirty || save.isPending}
                  className={BTN_PRIMARY_CLASS}
                >
                  {save.isPending ? "Saving…" : "Save"}
                </button>
              </Tooltip>
            </>
          ) : (
            <Tooltip
              multiline
              content="Writes your edits straight to this file on disk at its real path (e.g. ~/.claude/CLAUDE.md, a shell rc, or git config), replacing its contents. If the file doesn't exist yet it's created. Takes effect the next time something reads it."
            >
              <button
                type="button"
                onClick={() => save.mutate(draft)}
                disabled={!dirty || save.isPending}
                className={BTN_PRIMARY_CLASS}
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </Tooltip>
          )
        }
      />
      <p className="mb-3 text-xs text-gray-500">
        Common machine config — your global Claude Code memory, shell rc files, and git config. Edits write straight to disk.
      </p>

      <div className="flex min-h-0 flex-1 gap-6">
        <nav className="flex w-40 shrink-0 flex-col gap-1">
          {files.map((f) => (
            <Tooltip key={f.key} multiline content={f.exists ? f.path : `${f.path} — doesn't exist yet`}>
              <button
                type="button"
                onClick={() => select(f.key)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                  f.key === selected
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                }`}
              >
              <span
                aria-hidden
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${f.exists ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600"}`}
              />
              <span className="min-w-0 truncate">{f.label}</span>
            </button>
            </Tooltip>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {data && (
            <p className="mb-2 text-xs text-gray-500">
              <span className="font-mono">{data.path}</span>
              {data.exists && <OpenPathButton path={data.path} />}
              {!data.exists && <span className="ml-1 text-amber-600 dark:text-amber-400">— doesn't exist yet; Save will create it.</span>}
              {dirty && <span className="ml-1 text-accent">• unsaved changes</span>}
            </p>
          )}
          {isLoading ? (
            <p className="text-gray-400">loading…</p>
          ) : preview && data?.markdown ? (
            <article className="chat-md min-h-0 flex-1 overflow-auto rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
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
              className={`min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed ${FIELD_CLASS}`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
