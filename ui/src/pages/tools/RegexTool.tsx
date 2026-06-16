import {
  type ExplainNode,
  explainRegex,
  REGEX_BLOCKS,
  REGEX_FLAGS,
  REGEX_RECIPES,
  testRegex,
} from "@shared/tools/regex";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { deleteSavedRegex, fetchSavedRegexes, saveRegex } from "../../api";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, Tooltip } from "../../components";
import { useToast } from "../../toast";
import { ErrorNote, Field, SavedList, TOOL_TEXTAREA_CLASS } from "./toolkit";

/** Render the explainer's node tree recursively. */
function NodeTree({ nodes }: { nodes: ExplainNode[] }) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((n, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: explainer nodes are positional
        <li key={i} className="border-gray-100 border-l pl-2 dark:border-gray-800">
          <code className="rounded bg-gray-100 px-1 text-accent dark:bg-gray-800">{n.raw}</code>{" "}
          <span className="text-gray-600 dark:text-gray-300">{n.desc}</span>
          {n.children && n.children.length > 0 && (
            <div className="mt-0.5 ml-2">
              <NodeTree nodes={n.children} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function RegexTool() {
  const [pattern, setPattern] = useState("\\b\\w+@\\w+\\.\\w+\\b");
  const [flags, setFlags] = useState("g");
  const [input, setInput] = useState("Reach us at ada@x.io or grace@y.dev.");

  const explained = useMemo(() => explainRegex(pattern), [pattern]);
  const tested = useMemo(() => testRegex(pattern, flags, input), [pattern, flags, input]);

  const toggleFlag = (f: string) => setFlags((prev) => (prev.includes(f) ? prev.replace(f, "") : prev + f));

  // Saved patterns.
  const qc = useQueryClient();
  const { notify } = useToast();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const { data: saved = [] } = useQuery({ queryKey: ["saved-regex"], queryFn: fetchSavedRegexes });

  const save = useMutation({
    mutationFn: () => saveRegex({ title, pattern, flags, notes }),
    onSuccess: () => {
      setTitle("");
      setNotes("");
      notify("Saved", "success");
      qc.invalidateQueries({ queryKey: ["saved-regex"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteSavedRegex(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-regex"] }),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <Field label="Pattern">
          <div className="flex items-center gap-1.5">
            <span className="text-gray-400">/</span>
            <input
              className={`${FIELD_CLASS} flex-1 font-mono`}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              spellCheck={false}
            />
            <span className="text-gray-400">/{flags}</span>
          </div>
        </Field>

        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {REGEX_FLAGS.map((f) => (
            <Tooltip key={f.flag} content={f.description}>
              <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
                <input type="checkbox" checked={flags.includes(f.flag)} onChange={() => toggleFlag(f.flag)} />
                <code>{f.flag}</code> {f.label}
              </label>
            </Tooltip>
          ))}
        </div>

        <Field label="Recipes">
          <div className="flex flex-wrap gap-1">
            {REGEX_RECIPES.map((r) => (
              <Tooltip key={r.label} content={r.description}>
                <button
                  type="button"
                  className={`${BTN_GHOST_CLASS} py-0.5`}
                  onClick={() => {
                    setPattern(r.pattern);
                    setFlags(r.flags);
                  }}
                >
                  {r.label}
                </button>
              </Tooltip>
            ))}
          </div>
        </Field>

        <Field label="Insert">
          <div className="space-y-1.5">
            {REGEX_BLOCKS.map((g) => (
              <div key={g.group} className="flex flex-wrap items-center gap-1">
                <span className="w-28 shrink-0 text-xs text-gray-400">{g.group}</span>
                {g.blocks.map((b) => (
                  <Tooltip key={b.label} content={b.hint}>
                    <button
                      type="button"
                      className={`${BTN_GHOST_CLASS} py-0.5 font-mono`}
                      onClick={() => setPattern((p) => p + b.insert)}
                    >
                      {b.label}
                    </button>
                  </Tooltip>
                ))}
              </div>
            ))}
          </div>
        </Field>

        <Field label="Test input">
          <textarea
            className={`${TOOL_TEXTAREA_CLASS} h-28`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
          />
        </Field>
      </div>

      <div className="space-y-3">
        <div className={`${CARD_CLASS} p-3`}>
          <div className="mb-2 text-xs font-medium text-gray-500">Explanation</div>
          <ErrorNote message={explained.ok ? undefined : explained.error} />
          {explained.nodes.length > 0 ? (
            <div className="text-xs">
              <NodeTree nodes={explained.nodes} />
            </div>
          ) : (
            <p className="text-xs text-gray-400">Type a pattern to see it explained.</p>
          )}
        </div>

        <div className={`${CARD_CLASS} p-3`}>
          <div className="mb-2 text-xs font-medium text-gray-500">
            Matches{tested.ok ? ` (${tested.matches.length})` : ""}
          </div>
          <ErrorNote message={tested.ok ? undefined : tested.error} />
          {tested.ok &&
            (tested.matches.length > 0 ? (
              <ul className="space-y-1 font-mono text-xs">
                {tested.matches.map((m, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: matches are positional
                  <li key={i} className="flex flex-wrap items-baseline gap-2">
                    <span className="rounded bg-accent-soft px-1 text-accent">{m.match || "∅"}</span>
                    <span className="text-gray-400">@{m.index}</span>
                    {m.groups.length > 0 && (
                      <span className="text-gray-500">
                        {m.groups.map((g) => `${g.name}=${g.value ?? ""}`).join(", ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-gray-400">No matches.</p>
            ))}
        </div>

        <div className={`${CARD_CLASS} p-3`}>
          <div className="mb-2 text-xs font-medium text-gray-500">Saved patterns</div>
          <div className="mb-2 space-y-1.5">
            <div className="flex gap-1.5">
              <input
                className={`${FIELD_CLASS} flex-1 py-1`}
                placeholder="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <button
                type="button"
                className={BTN_PRIMARY_CLASS}
                disabled={!title.trim() || !pattern || save.isPending}
                onClick={() => save.mutate()}
              >
                Save
              </button>
            </div>
            <input
              className={`${FIELD_CLASS} w-full py-1`}
              placeholder="notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <SavedList
            items={saved.map((s) => ({ id: s.id, label: s.title, sub: `/${s.pattern}/${s.flags}` }))}
            onLoad={(id) => {
              const found = saved.find((s) => s.id === id);
              if (found) {
                setPattern(found.pattern);
                setFlags(found.flags);
                setTitle(found.title);
                setNotes(found.notes);
              }
            }}
            onDelete={(id) => del.mutate(id)}
          />
        </div>
      </div>
    </div>
  );
}
