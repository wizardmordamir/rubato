import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AutomationEnvironment, EnvVar } from "@shared/automationEnvironment";
import {
  deleteAutomationEnvironment,
  fetchAutomationEnvironments,
  saveAutomationEnvironment,
} from "../api";
import {
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  FIELD_CLASS,
  PageHeading,
  Tooltip,
} from "../components";
import { useConfirm } from "../confirm";
import { IconPlus, IconTrash } from "../icons";
import { useToast } from "../toast";

const emptyVar = (): EnvVar => ({ key: "", value: "", enabled: true });

/**
 * Manage automation environments — Postman-style named sets of key-value variables.
 * Select one in the Run options popover to inject those values into a run, allowing
 * the same automation to run against dev, staging, prod without editing `.env`.
 */
export function AutomationEnvironmentsPage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { data: envs = [] } = useQuery({
    queryKey: ["automation-environments"],
    queryFn: fetchAutomationEnvironments,
  });

  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<AutomationEnvironment> & { variables: EnvVar[] }>({
    name: "",
    variables: [],
  });

  const active = envs.find((e) => e.id === activeId) ?? null;

  const select = (e: AutomationEnvironment) => {
    setActiveId(e.id);
    setDraft({ ...e, variables: e.variables.length ? e.variables : [] });
  };

  const newEnv = () => {
    setActiveId(null);
    setDraft({ name: "", variables: [emptyVar()] });
  };

  const save = useMutation({
    mutationFn: () =>
      saveAutomationEnvironment({
        id: activeId ?? undefined,
        name: draft.name ?? "",
        variables: draft.variables,
      }),
    onSuccess: (saved) => {
      notify(`Saved "${saved.name}"`, "success");
      qc.invalidateQueries({ queryKey: ["automation-environments"] });
      setActiveId(saved.id);
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteAutomationEnvironment(id),
    onSuccess: () => {
      notify("Deleted", "success");
      qc.invalidateQueries({ queryKey: ["automation-environments"] });
      setActiveId(null);
      setDraft({ name: "", variables: [] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "delete failed", "error"),
  });

  const setVar = (i: number, patch: Partial<EnvVar>) =>
    setDraft((d) => ({ ...d, variables: d.variables.map((v, j) => (j === i ? { ...v, ...patch } : v)) }));

  const addVar = () => setDraft((d) => ({ ...d, variables: [...d.variables, emptyVar()] }));
  const removeVar = (i: number) => setDraft((d) => ({ ...d, variables: d.variables.filter((_, j) => j !== i) }));

  return (
    <div>
      <PageHeading
        title="Environments"
        count={envs.length}
        actions={
          <Tooltip content="Create a new environment">
            <button type="button" onClick={newEnv} className={BTN_PRIMARY_CLASS}>
              <IconPlus size={14} /> New environment
            </button>
          </Tooltip>
        }
      />
      <p className="mb-4 text-xs text-gray-400">
        Named sets of variables — pick one in Run options to inject its values into a run. Use them to switch between
        dev, staging, and prod without editing <code>.env</code>. Variables here override <code>.env</code> values.
      </p>

      <div className="flex gap-6">
        {/* Sidebar: environment list */}
        <div className="w-44 shrink-0">
          {envs.length === 0 && (
            <p className="text-xs text-gray-400">No environments yet. Create one →</p>
          )}
          <ul className="space-y-1">
            {envs.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => select(e)}
                  className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                    activeId === e.id
                      ? "bg-accent text-white"
                      : "hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  {e.name}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Editor panel */}
        {(activeId !== null || draft.name !== "" || draft.variables.length > 0) ? (
          <div className={`${CARD_CLASS} flex-1 p-4`}>
            <div className="mb-3 flex items-center gap-2">
              <input
                className={`${FIELD_CLASS} flex-1`}
                placeholder="Environment name (e.g. Staging)"
                value={draft.name ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
              {active && (
                <button
                  type="button"
                  onClick={async () => {
                    if (await confirm({ prompt: `Delete "${active.name}"?`, confirmText: "Delete" }))
                      del.mutate(active.id);
                  }}
                  aria-label="Delete environment"
                  className="inline-flex items-center rounded-lg border border-gray-300 p-1.5 text-red-600 transition-colors hover:bg-red-50 dark:border-gray-700"
                >
                  <IconTrash size={15} />
                </button>
              )}
            </div>

            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Variables</div>
            <p className="mb-2 text-xs text-gray-400">
              Reference as <code className="font-mono">${"{KEY}"}</code> in automation steps. Checked rows are active.
            </p>

            <div className="space-y-1.5">
              {draft.variables.map((v, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
                <div key={i} className="flex items-center gap-1.5">
                  <Tooltip content="enabled">
                    <input
                      type="checkbox"
                      aria-label="enabled"
                      checked={v.enabled}
                      onChange={(e) => setVar(i, { enabled: e.target.checked })}
                    />
                  </Tooltip>
                  <input
                    className={`${FIELD_CLASS} w-36 py-1 font-mono`}
                    placeholder="KEY"
                    value={v.key}
                    onChange={(e) => setVar(i, { key: e.target.value })}
                  />
                  <input
                    className={`${FIELD_CLASS} flex-1 py-1 font-mono`}
                    placeholder="value"
                    value={v.value}
                    onChange={(e) => setVar(i, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className={BTN_GHOST_CLASS}
                    onClick={() => removeVar(i)}
                    aria-label="Remove variable"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" className={BTN_GHOST_CLASS} onClick={addVar}>
                + add variable
              </button>
            </div>

            <div className="mt-4">
              <button
                type="button"
                className={BTN_PRIMARY_CLASS}
                disabled={!draft.name?.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : activeId ? "Save" : "Create"}
              </button>
            </div>
          </div>
        ) : (
          <p className="flex-1 text-sm text-gray-400">
            {envs.length > 0 ? "Select an environment to edit it." : "Create an environment to get started."}
          </p>
        )}
      </div>
    </div>
  );
}
