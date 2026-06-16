import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { deletePlan, fetchPlans, type Plan, savePlan } from "../api";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, PageHeading, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { downloadText } from "../result/download";

/**
 * Plans — view/edit/export AI remediation plans (Markdown). Plans are produced by
 * the `ai-remediation-plan` pipeline script (vuln data → LLM → Markdown) or added
 * by hand here. The right pane renders the selected plan, or edits it as raw
 * Markdown; "Export" downloads a .md file.
 */

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "plan";

export function PlansPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: plans = [] } = useQuery({ queryKey: ["plans"], queryFn: fetchPlans });

  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");

  const selected = plans.find((p) => p.id === selectedId);

  // Keep a selection; default to the most recent plan.
  useEffect(() => {
    if (!selectedId && plans.length) setSelectedId(plans[0].id);
  }, [selectedId, plans]);

  const beginEdit = (p: Plan) => {
    setDraftTitle(p.title);
    setDraftContent(p.content);
    setEditing(true);
  };

  const save = useMutation({
    mutationFn: (input: { id?: string; title: string; content: string; app?: string | null }) => savePlan(input),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["plans"] });
      setSelectedId(p.id);
      setEditing(false);
    },
  });

  const remove = useMutation({
    mutationFn: deletePlan,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plans"] });
      setSelectedId(undefined);
      setEditing(false);
    },
  });

  const newPlan = () => {
    setSelectedId(undefined);
    setDraftTitle("Untitled plan");
    setDraftContent("# Remediation plan\n\n");
    setEditing(true);
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      <PageHeading
        title="Plans"
        count={plans.length}
        actions={
          <Tooltip
            multiline
            content="Creates a new plan — a Markdown remediation document you write by hand. (Plans are also generated automatically by the ai-remediation-plan pipeline script from vulnerability data.) Edit it here and Export it as a .md file."
          >
            <button type="button" className={BTN_GHOST_CLASS} onClick={newPlan}>
              + New plan
            </button>
          </Tooltip>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        {/* List */}
        <div className={`${CARD_CLASS} flex min-h-0 flex-col gap-1 overflow-auto p-2`}>
          {plans.length === 0 ? (
            <p className="p-2 text-gray-500 text-sm">
              No plans yet. Generate one with the <code>ai-remediation-plan</code> pipeline script, or add one by
              hand.
            </p>
          ) : (
            plans.map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() => {
                  setSelectedId(p.id);
                  setEditing(false);
                }}
                className={`truncate rounded px-2 py-1.5 text-left text-sm transition-colors ${
                  p.id === selectedId ? "bg-accent/10 font-medium text-accent" : "hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                {p.title}
                {p.app ? <span className="ml-1 text-gray-400 text-xs">· {p.app}</span> : null}
              </button>
            ))
          )}
        </div>

        {/* Detail / editor */}
        <div className={`${CARD_CLASS} flex min-h-0 flex-col overflow-hidden`}>
          {editing ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
              <input
                className={FIELD_CLASS}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Plan title"
              />
              <textarea
                className={`${FIELD_CLASS} min-h-0 flex-1 resize-none font-mono text-sm`}
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                placeholder="# Remediation plan…"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={BTN_PRIMARY_CLASS}
                  disabled={!draftTitle.trim() || save.isPending}
                  onClick={() =>
                    save.mutate({ id: selected?.id, title: draftTitle.trim(), content: draftContent, app: selected?.app })
                  }
                >
                  Save
                </button>
                <button type="button" className={BTN_GHOST_CLASS} onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : selected ? (
            <>
              <div className="flex items-center justify-between gap-2 border-gray-200 border-b p-3 dark:border-gray-800">
                <h3 className="truncate font-semibold">{selected.title}</h3>
                <div className="flex shrink-0 items-center gap-2">
                  <button type="button" className={BTN_GHOST_CLASS} onClick={() => beginEdit(selected)}>
                    Edit
                  </button>
                  <Tooltip
                    multiline
                    content="Downloads this plan's Markdown content as a .md file (named from its title) so you can share it or commit it outside the app."
                  >
                    <button
                      type="button"
                      className={BTN_GHOST_CLASS}
                      onClick={() => downloadText(`${slug(selected.title)}.md`, selected.content, "text/markdown")}
                    >
                      Export .md
                    </button>
                  </Tooltip>
                  <button
                    type="button"
                    className={`${BTN_GHOST_CLASS} text-rose-600`}
                    onClick={async () => {
                      if (await confirm({ prompt: "Delete this plan?", confirmText: "Delete" })) remove.mutate(selected.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <article className="chat-md min-h-0 flex-1 overflow-auto p-4 dark:text-gray-300">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {selected.content}
                </ReactMarkdown>
              </article>
            </>
          ) : (
            <p className="p-4 text-gray-500 text-sm">Select a plan, or create a new one.</p>
          )}
        </div>
      </div>
    </div>
  );
}
