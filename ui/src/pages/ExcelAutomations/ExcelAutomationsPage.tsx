import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { ExcelAutomation, ExcelRecipe } from "cwip/excel-engine/types";
import { BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_INTERACTIVE_CLASS, PageHeading, Tooltip } from "../../components";
import {
  originalDownloadUrl,
  useApplyRecipe,
  useDeleteProject,
  useDeleteRecipe,
  useExcelProjectsQuery,
  useRecipesQuery,
  useUploadProject,
} from "../../hooks/useExcelAutomations";
import { useConfirm } from "../../confirm";
import { IconTrash } from "../../icons";
import { useToast } from "../../toast";

// Same affordance the Browser library uses for its destructive row action.
const DELETE_BTN_CLASS =
  "inline-flex items-center rounded-lg border border-gray-300 p-1.5 text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 dark:border-gray-700 dark:hover:bg-red-950";

/**
 * The Excel library — saved **automations** (reusable, file-agnostic step sequences;
 * stored server-side as "recipes") listed by name up top, then the uploaded **files**
 * each automation runs against. Apply an automation to any file to open it in the
 * builder with the steps already applied.
 */
export function ExcelAutomationsPage() {
  const navigate = useNavigate();
  const { notify } = useToast();
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);
  const { data: projects = [], isLoading } = useExcelProjectsQuery();
  const { data: automations = [], isLoading: automationsLoading } = useRecipesQuery();
  const upload = useUploadProject();
  const removeProject = useDeleteProject();
  const removeAutomation = useDeleteRecipe();
  const applyAutomation = useApplyRecipe();

  const onPick = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const created = await upload.mutateAsync(files[0]);
      notify("File uploaded", "success");
      if (created?.id) navigate(`/excel-automations/${created.id}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Upload failed", "error");
    }
  };

  const applyToFile = (recipeId: string, projectId: string) => {
    applyAutomation.mutate(
      { projectId, recipeId },
      {
        onSuccess: () => {
          notify("Automation applied", "success");
          navigate(`/excel-automations/${projectId}`);
        },
        onError: (e) => notify(e instanceof Error ? e.message : "Apply failed", "error"),
      },
    );
  };

  return (
    <div>
      <PageHeading
        title="Excel Automations"
        count={automations.length}
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => onPick(e.target.files)}
            />
            <Tooltip
              multiline
              content="Upload a spreadsheet (.xlsx, .xls, or .csv) to work on. The original is stored untouched and stays re-downloadable; all steps run against a working copy. Opens the new file in the builder."
            >
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={upload.isPending}
                className={BTN_PRIMARY_CLASS}
              >
                {upload.isPending ? "Uploading…" : "Upload file"}
              </button>
            </Tooltip>
          </>
        }
      />
      <p className="mb-4 text-xs text-gray-400">
        Save reusable step sequences as automations, then apply them to any uploaded file — the original is always kept
        safe and re-downloadable.
      </p>

      {/* Automations — reusable step sequences, the repeatable thing you apply to a file. */}
      {automationsLoading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : automations.length === 0 ? (
        <p className="mb-8 text-sm text-gray-400">
          No saved automations yet. Open a file, build some steps, then "Save current" to store a reusable automation.
        </p>
      ) : (
        <ul className="mb-8 space-y-2">
          {automations.map((a: ExcelRecipe) => (
            <li key={a.id} className={`${CARD_INTERACTIVE_CLASS} flex items-center gap-3 p-3`}>
              <div className="min-w-0 flex-1">
                <span className="font-medium text-gray-900 dark:text-gray-100">{a.name || "Untitled"}</span>
                <span className="ml-2 text-xs text-gray-400">
                  {a.steps.length} step{a.steps.length === 1 ? "" : "s"}
                </span>
                {a.description && <div className="truncate text-xs text-gray-500">{a.description}</div>}
              </div>
              <Tooltip
                multiline
                content="Run this saved automation's steps against the file you pick — the result opens in the builder as a new revision. The chosen file's original is never modified."
              >
                <select
                  className="rounded-lg border border-gray-300 bg-transparent px-2 py-1.5 text-xs dark:border-gray-600"
                  value=""
                  disabled={projects.length === 0 || applyAutomation.isPending}
                  title={projects.length === 0 ? "Upload a file first" : "Apply this automation to a file"}
                  onChange={(e) => {
                    if (e.target.value) applyToFile(a.id, e.target.value);
                    e.target.value = "";
                  }}
                >
                  <option value="">{projects.length === 0 ? "Upload a file first" : "Apply to…"}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || "Untitled"}
                    </option>
                  ))}
                </select>
              </Tooltip>
              <Tooltip
                multiline
                content="Permanently delete this saved automation. Files you already applied it to keep their revisions — only the reusable step sequence is removed."
              >
                <button
                  type="button"
                  aria-label="Delete"
                  className={DELETE_BTN_CLASS}
                  onClick={async () => {
                    if (await confirm({ prompt: `Delete automation "${a.name}"?`, confirmText: "Delete" })) {
                      removeAutomation.mutate(
                        { id: a.id },
                        {
                          onSuccess: () => notify("Automation deleted", "success"),
                          onError: (e) => notify(e instanceof Error ? e.message : "Delete failed", "error"),
                        },
                      );
                    }
                  }}
                >
                  <IconTrash size={15} />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}

      {/* Files — the source spreadsheets each automation runs against. */}
      <h2 className="mb-1 text-sm font-semibold text-gray-500">Files</h2>
      <p className="mb-3 text-xs text-gray-400">Uploaded Excel/CSV spreadsheets. Open one to build or run steps.</p>
      {isLoading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-gray-400">No files yet. Upload a spreadsheet to get started.</p>
      ) : (
        <ul className="space-y-2">
          {projects.map((p: ExcelAutomation) => (
            <li key={p.id} className={`${CARD_INTERACTIVE_CLASS} flex items-center gap-3 p-3`}>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => navigate(`/excel-automations/${p.id}`)}
              >
                <span className="font-medium text-gray-900 hover:text-accent dark:text-gray-100">
                  {p.name || "Untitled"}
                </span>
                <span className="ml-2 text-xs uppercase text-gray-400">{p.sourceKind}</span>
              </button>
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                onClick={() => navigate(`/excel-automations/${p.id}`)}
              >
                Open
              </button>
              <Tooltip multiline content="Download the original uploaded spreadsheet, exactly as it was — no automation steps applied.">
                <a className={BTN_GHOST_CLASS} href={originalDownloadUrl(p.id)}>
                  Original
                </a>
              </Tooltip>
              <Tooltip
                multiline
                content="Permanently delete this file and every revision built from it (snapshots and results included). This cannot be undone."
              >
                <button
                  type="button"
                  aria-label="Delete"
                  className={DELETE_BTN_CLASS}
                  onClick={async () => {
                    if (
                      await confirm({
                        prompt: `Delete "${p.name}" and all its revisions?`,
                        flavorText: "This cannot be undone.",
                        confirmText: "Delete",
                      })
                    ) {
                      removeProject.mutate(
                        { id: p.id },
                        {
                          onSuccess: () => notify("File deleted", "success"),
                          onError: (e) => notify(e instanceof Error ? e.message : "Delete failed", "error"),
                        },
                      );
                    }
                  }}
                >
                  <IconTrash size={15} />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
