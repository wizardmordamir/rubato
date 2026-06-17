import type { AutomationStep, RevisionView, StepResult } from "cwip/excel-engine/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useRegisterBreadcrumbLabel } from "../../breadcrumbs";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, Tooltip } from "../../components";
import { SpreadsheetGrid } from "../../components/SpreadsheetGrid";
import {
  originalDownloadUrl,
  resultDownloadUrl,
  revisionDownloadUrl,
  useApplyRecipe,
  useDeleteRevision,
  useExcelProjectQuery,
  useManualEdit,
  useRecipesQuery,
  useRevisionsQuery,
  useRevisionViewQuery,
  useRunAll,
  useRunSingleStep,
  useSaveRecipe,
  useSaveSnapshot,
  useSaveSteps,
  useSelectRevision,
  useUndoStep,
} from "../../hooks/useExcelAutomations";
import { useConfirm } from "../../confirm";
import { usePrompt } from "../../prompt";
import { BuilderContext } from "./builder/model";
import { StepList } from "./builder/StepList";

export function AutomationBuilderPage() {
  const { id: projectId = "" } = useParams();
  const { data: project } = useExcelProjectQuery(projectId);
  useRegisterBreadcrumbLabel(project?.name);
  const { data: revisions = [] } = useRevisionsQuery(projectId);

  const [steps, setSteps] = useState<AutomationStep[]>([]);
  const [activeRevisionId, setActiveRevisionId] = useState<string>("");
  const [activeSheet, setActiveSheet] = useState<string>("");
  const [debug, setDebug] = useState(false);
  const [cursor, setCursor] = useState(-1); // index of the NEXT step to run
  const [results, setResults] = useState<Record<number, StepResult>>({});
  const [localView, setLocalView] = useState<RevisionView | null>(null);
  const [editing, setEditing] = useState(false);

  const saveSteps = useSaveSteps();
  const runAll = useRunAll(projectId);
  const runStep = useRunSingleStep(projectId);
  const undo = useUndoStep(projectId);
  const manualEdit = useManualEdit(projectId);
  const selectRevision = useSelectRevision(projectId);
  const saveSnapshot = useSaveSnapshot(projectId);
  const deleteRevision = useDeleteRevision(projectId);
  const saveRecipe = useSaveRecipe();
  const applyRecipe = useApplyRecipe();
  const { data: recipes = [] } = useRecipesQuery();

  // Seed local steps + active revision once the project loads.
  const seeded = useRef(false);
  useEffect(() => {
    if (project && !seeded.current) {
      seeded.current = true;
      setSteps(project.steps);
      setActiveRevisionId(project.currentRevisionId ?? project.originalRevisionId ?? "");
    }
  }, [project]);

  // The grid shows a live debug/run view when we have one, else the queried view
  // of the active revision.
  const { data: queryView } = useRevisionViewQuery(
    projectId,
    localView ? undefined : activeRevisionId,
    activeSheet || undefined,
  );
  const view = localView ?? queryView;

  useEffect(() => {
    if (view && !activeSheet) setActiveSheet(view.activeSheet);
  }, [view, activeSheet]);

  const builderCtx = useMemo(() => ({ columns: view?.columns ?? [], sheets: view?.sheets ?? [] }), [view]);

  // Debounced autosave of steps.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateSteps = (next: AutomationStep[]) => {
    setSteps(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveSteps.mutate({ id: projectId, steps: next });
    }, 700);
  };
  const flushSteps = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    await saveSteps.mutateAsync({ id: projectId, steps });
  };

  if (!project) return <p className="p-6 text-sm text-gray-400">Loading…</p>;

  // ── actions ────────────────────────────────────────────────────────────────
  const onRunAll = async () => {
    await flushSteps();
    const res = await runAll.mutateAsync();
    const map: Record<number, StepResult> = {};
    res.steps.forEach((s) => {
      map[s.stepIndex] = s;
    });
    setResults(map);
    setDebug(false);
    setEditing(false);
    setLocalView(null);
    if (res.resultRevisionId) setActiveRevisionId(res.resultRevisionId);
  };

  const startDebug = async () => {
    await flushSteps();
    const origin = project.originalRevisionId ?? "";
    await selectRevision.mutateAsync({ revisionId: origin });
    setDebug(true);
    setEditing(false);
    setCursor(0);
    setResults({});
    setLocalView(null);
    setActiveRevisionId(origin);
  };

  const stepForward = async () => {
    if (cursor >= steps.length) return;
    const res = await runStep.mutateAsync({ stepIndex: cursor, sheet: activeSheet || undefined });
    if (res.result) setResults((r) => ({ ...r, [cursor]: res.result! }));
    setLocalView(res.revision);
    if (res.result?.status !== "error") setCursor((c) => c + 1);
  };

  const stepBack = async () => {
    const res = await undo.mutateAsync({ sheet: activeSheet || undefined });
    setLocalView(res.revision);
    setCursor((c) => {
      const next = Math.max(0, c - 1);
      setResults((r) => {
        const copy = { ...r };
        delete copy[next];
        return copy;
      });
      return next;
    });
  };

  const exitDebug = () => {
    setDebug(false);
    setEditing(false);
    setLocalView(null);
    setCursor(-1);
    setActiveRevisionId(project.currentRevisionId ?? project.originalRevisionId ?? "");
  };

  const onCellEdit = async (edit: { row: number; col: number; value: unknown }) => {
    // If the step we're on is a manualEdit step, record into it; else a free edit.
    const stepIndex = steps[cursor]?.type === "manualEdit" ? cursor : undefined;
    const res = await manualEdit.mutateAsync({
      stepIndex,
      sheet: view?.activeSheet,
      edits: [edit],
    });
    setLocalView(res.revision);
  };

  const switchRevision = async (revisionId: string) => {
    setLocalView(null);
    setActiveRevisionId(revisionId);
    setActiveSheet("");
    await selectRevision.mutateAsync({ revisionId });
  };

  const currentRevisionId = view?.revisionId ?? activeRevisionId;
  const canEdit = debug; // manual editing only inside debug

  return (
    <div>
      <div className="mb-4 flex flex-wrap justify-end gap-2">
        <div className="flex flex-wrap items-center gap-2">
            <Tooltip multiline content="Download the original uploaded file, with no steps applied.">
              <a className="text-xs text-gray-500 hover:underline" href={originalDownloadUrl(projectId)}>
                Original
              </a>
            </Tooltip>
            {!debug ? (
              <>
                <Tooltip
                  multiline
                  content="Run every enabled step in order against the original file and save the output as a new result revision (shown in the grid). Doesn't touch the original."
                >
                  <button type="button" className={BTN_PRIMARY_CLASS} onClick={onRunAll} disabled={runAll.isPending}>
                    {runAll.isPending ? "Running…" : "▶ Run all"}
                  </button>
                </Tooltip>
                <Tooltip
                  multiline
                  content="Step through the automation one step at a time from the original, inspecting the grid after each step — to see exactly what each step does or find where one goes wrong."
                >
                  <button type="button" className={BTN_GHOST_CLASS} onClick={startDebug}>
                    Debug
                  </button>
                </Tooltip>
              </>
            ) : (
              <>
                <Tooltip multiline content="Run the next step and show its effect in the grid, advancing the cursor. Stops on the highlighted step if it errors.">
                  <button
                    type="button"
                    className={BTN_PRIMARY_CLASS}
                    onClick={stepForward}
                    disabled={cursor >= steps.length || runStep.isPending}
                  >
                    Step ▶
                  </button>
                </Tooltip>
                <Tooltip multiline content="Undo the last applied step and move the cursor back one, reverting the grid to before that step ran.">
                  <button type="button" className={BTN_GHOST_CLASS} onClick={stepBack} disabled={cursor <= 0}>
                    ◀ Undo
                  </button>
                </Tooltip>
                <Tooltip multiline content="Toggle hand-editing of grid cells at this point in the run. Edits become a manualEdit step recorded into the automation.">
                  <button type="button" className={BTN_GHOST_CLASS} onClick={() => setEditing((v) => !v)}>
                    {editing ? "Done editing" : "✎ Edit cells"}
                  </button>
                </Tooltip>
                <Tooltip multiline content="Leave step-by-step debugging and return to the file's current revision. Your steps are kept.">
                  <button type="button" className={BTN_GHOST_CLASS} onClick={exitDebug}>
                    Exit debug
                  </button>
                </Tooltip>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(340px,400px)_1fr]">
        {/* Steps column */}
        <div className="space-y-3">
          <BuilderContext.Provider value={builderCtx}>
            <StepList
              steps={steps}
              onChange={updateSteps}
              results={results}
              currentIndex={debug ? cursor : undefined}
            />
          </BuilderContext.Provider>

          <RecipeBar
            onSaveRecipe={async (name) => {
              await flushSteps();
              await saveRecipe.mutateAsync({ name, steps });
            }}
            recipes={recipes.map((r) => ({ id: r.id, name: r.name }))}
            onApplyRecipe={async (recipeId) => {
              const res = await applyRecipe.mutateAsync({ projectId, recipeId });
              setSteps(res.steps);
            }}
          />
        </div>

        {/* Grid + revisions column */}
        <div className="flex min-h-0 flex-col gap-2">
          <RevisionBar
            projectId={projectId}
            revisions={revisions}
            currentRevisionId={currentRevisionId}
            resultRevisionId={project.resultRevisionId}
            onSwitch={switchRevision}
            onSnapshot={async (label) => {
              await saveSnapshot.mutateAsync({ label });
            }}
            onDeleteRevision={(revisionId) => deleteRevision.mutate({ revisionId })}
          />
          <div className="h-[60vh] min-h-[400px] overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
            {view ? (
              <SpreadsheetGrid
                view={view}
                onSheetChange={(s) => {
                  setActiveSheet(s);
                  setLocalView(null);
                }}
                readOnly={!(canEdit && editing)}
                onCellEdit={canEdit && editing ? onCellEdit : undefined}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-gray-400">
                No data — run or step to see the working copy.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Revisions bar ──────────────────────────────────────────────────────────────
const RevisionBar = ({
  projectId,
  revisions,
  currentRevisionId,
  resultRevisionId,
  onSwitch,
  onSnapshot,
  onDeleteRevision,
}: {
  projectId: string;
  revisions: { id: string; label: string; kind: string; seq: number }[];
  currentRevisionId: string;
  resultRevisionId?: string;
  onSwitch: (revisionId: string) => void;
  onSnapshot: (label: string) => void;
  onDeleteRevision: (revisionId: string) => void;
}) => {
  const confirm = useConfirm();
  const prompt = usePrompt();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <select
        className="rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
        value={currentRevisionId}
        onChange={(e) => onSwitch(e.target.value)}
      >
        {revisions.map((r) => (
          <option key={r.id} value={r.id}>
            #{r.seq} {r.label || r.kind}
          </option>
        ))}
      </select>
      <Tooltip multiline content="Save the revision currently shown in the grid as a named, permanent snapshot you can return to later from this dropdown.">
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={async () => {
            const label = await prompt({ prompt: "Snapshot name?", defaultValue: "Snapshot", confirmText: "Save" });
            if (label != null) onSnapshot(label);
          }}
        >
          Save snapshot
        </button>
      </Tooltip>
      {currentRevisionId && (
        <Tooltip multiline content="Download the revision currently shown in the grid as a spreadsheet file.">
          <a className="text-gray-500 hover:underline" href={revisionDownloadUrl(projectId, currentRevisionId)}>
            Export this
          </a>
        </Tooltip>
      )}
      {resultRevisionId && (
        <Tooltip multiline content="Download the latest full Run-all result (the output of running every step), regardless of which revision is shown.">
          <a className="text-gray-500 hover:underline" href={resultDownloadUrl(projectId)}>
            Export result
          </a>
        </Tooltip>
      )}
      {currentRevisionId && (
        <Tooltip multiline content="Permanently delete the revision shown in the grid. The original and other revisions are unaffected.">
          <button
            type="button"
            className="ml-auto text-gray-400 hover:text-red-500"
            onClick={async () => {
              if (await confirm({ prompt: "Delete this revision?", confirmText: "Delete" }))
                onDeleteRevision(currentRevisionId);
            }}
          >
            Delete revision
          </button>
        </Tooltip>
      )}
    </div>
  );
};

// ── Recipe bar ──────────────────────────────────────────────────────────────────
const RecipeBar = ({
  recipes,
  onSaveRecipe,
  onApplyRecipe,
}: {
  recipes: { id: string; name: string }[];
  onSaveRecipe: (name: string) => void;
  onApplyRecipe: (recipeId: string) => void;
}) => {
  const prompt = usePrompt();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 p-2 text-xs dark:border-gray-700">
      <span className="font-semibold text-gray-500">Automations</span>
      <Tooltip multiline content="Save this file's current list of steps as a reusable, named automation you can later apply to other files.">
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={async () => {
            const name = await prompt("Save these steps as an automation named:");
            if (name) onSaveRecipe(name);
          }}
        >
          Save current
        </button>
      </Tooltip>
      {recipes.length > 0 && (
        <Tooltip multiline content="Replace this file's steps with the steps from a saved automation.">
          <select
            className="rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
            value=""
            onChange={(e) => {
              if (e.target.value) onApplyRecipe(e.target.value);
            }}
          >
            <option value="">Apply automation…</option>
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Tooltip>
      )}
    </div>
  );
};
