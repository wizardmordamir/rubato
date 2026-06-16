// The "Pipelines" page: chain automations + custom scripts into an ordered flow
// that shares a vars bag and a per-run working dir (files hand off between stages).
// Left: saved pipelines. Right: a builder (add/reorder stages, pick kind+ref, edit
// per-stage `with` vars) plus a run panel whose stages light up live over /ws and a
// preload form for any variables the pipeline needs.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ExcelStageIO } from "@shared/pipeline";
import {
  type Pipeline,
  type PipelineStage,
  type PipelineStageKind,
  type PipelineStageResult,
  deletePipeline,
  fetchAutomations,
  fetchExcelProjects,
  fetchPipelines,
  fetchPipelineVariables,
  fetchScripts,
  runPipeline,
  savePipeline,
} from "../api";
import {
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  CARD_INTERACTIVE_CLASS,
  InfoHint,
  PageHeading,
  Tooltip,
} from "../components";
import { useConfirm } from "../confirm";
import { useServerEvent } from "../liveBus";
import { useToast } from "../toast";

type Draft = { id?: string; name: string; description: string; stages: PipelineStage[] };

const BLANK: Draft = { name: "", description: "", stages: [] };

function newStage(): PipelineStage {
  return { id: crypto.randomUUID(), kind: "automation", ref: "" };
}

/** Serialize a stage's `with` map to editable `key=value` lines, and back. */
function withToText(w?: Record<string, string>): string {
  return Object.entries(w ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}
function textToWith(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function PipelinesPage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const { data: pipelines = [] } = useQuery({ queryKey: ["pipelines"], queryFn: fetchPipelines });
  const [draft, setDraft] = useState<Draft | null>(null);

  const startNew = () => setDraft({ ...BLANK, stages: [newStage()] });
  const edit = (p: Pipeline) =>
    setDraft({ id: p.id, name: p.name, description: p.description ?? "", stages: p.stages });

  return (
    <div>
      <PageHeading
        title="Pipelines"
        count={pipelines.length}
        actions={
          <Tooltip
            multiline
            content="Create a pipeline — an ordered, multi-stage workflow where each stage (an automation, script, or Excel job) runs in sequence, sharing a run directory and a vars bag so files and values hand off from one stage to the next."
          >
            <button type="button" onClick={startNew} className={BTN_PRIMARY_CLASS}>
              + New pipeline
            </button>
          </Tooltip>
        }
      />
      <p className="mb-4 text-xs text-gray-400">
        Run stages in sequence (Jenkins-style): an automation downloads a file, a script transforms it, and the report
        lands in the run dir for the Files tab. Stages pass files via <code>${"{run.dir}"}</code> and values via the vars
        bag.
      </p>

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <ul className="space-y-2">
          {pipelines.length === 0 && <li className="text-sm text-gray-400">No pipelines yet.</li>}
          {pipelines.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => edit(p)}
                className={`${CARD_INTERACTIVE_CLASS} block w-full p-3 text-left ${draft?.id === p.id ? "ring-2 ring-accent" : ""}`}
              >
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-gray-400">{p.stages.length} stages</div>
              </button>
            </li>
          ))}
        </ul>

        <div>
          {draft ? (
            <PipelineEditor
              key={draft.id ?? "new"}
              draft={draft}
              onChange={setDraft}
              onSaved={() => qc.invalidateQueries({ queryKey: ["pipelines"] })}
              onClose={() => setDraft(null)}
              onDeleted={() => {
                qc.invalidateQueries({ queryKey: ["pipelines"] });
                setDraft(null);
              }}
              notify={notify}
            />
          ) : (
            <p className="text-sm text-gray-400">Select a pipeline to edit, or create a new one.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PipelineEditor({
  draft,
  onChange,
  onSaved,
  onClose,
  onDeleted,
  notify,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSaved: () => void;
  onClose: () => void;
  onDeleted: () => void;
  notify: (msg: string, kind?: "success" | "error" | "info") => void;
}) {
  const confirm = useConfirm();
  const { data: automations = [] } = useQuery({ queryKey: ["automations"], queryFn: fetchAutomations });
  const { data: scripts = [] } = useQuery({ queryKey: ["scripts"], queryFn: fetchScripts });
  const { data: excels = [] } = useQuery({ queryKey: ["excel-automations"], queryFn: fetchExcelProjects });

  const refs = (kind: PipelineStageKind): { id: string; name: string }[] =>
    kind === "script"
      ? scripts.map((s) => ({ id: s.id, name: s.name }))
      : kind === "excel"
        ? excels.map((e) => ({ id: e.id, name: e.name }))
        : automations.map((a) => ({ id: a.id, name: a.name }));

  const setStage = (i: number, patch: Partial<PipelineStage>) =>
    onChange({ ...draft, stages: draft.stages.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) });
  const removeStage = (i: number) => onChange({ ...draft, stages: draft.stages.filter((_, idx) => idx !== i) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.stages.length) return;
    const next = [...draft.stages];
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ ...draft, stages: next });
  };

  const save = useMutation({
    mutationFn: () =>
      savePipeline({ id: draft.id, name: draft.name, description: draft.description, stages: draft.stages }),
    onSuccess: (saved) => {
      notify("Saved", "success");
      onChange({ id: saved.id, name: saved.name, description: saved.description ?? "", stages: saved.stages });
      onSaved();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const del = useMutation({
    mutationFn: () => deletePipeline(draft.id as string),
    onSuccess: () => {
      notify("Deleted", "success");
      onDeleted();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "delete failed", "error"),
  });

  const EXCEL_IO_DEFAULT: ExcelStageIO = { input: "", output: { file: "", to: "run", format: "csv" } };
  const setExcel = (i: number, stage: PipelineStage, patch: Partial<ExcelStageIO>) =>
    setStage(i, { excel: { ...(stage.excel ?? EXCEL_IO_DEFAULT), ...patch } });
  const setExcelOut = (i: number, stage: PipelineStage, patch: Partial<ExcelStageIO["output"]>) =>
    setStage(i, {
      excel: {
        ...(stage.excel ?? EXCEL_IO_DEFAULT),
        output: { ...(stage.excel?.output ?? EXCEL_IO_DEFAULT.output), ...patch },
      },
    });
  const ioField = "mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950";

  const stageReady = (s: PipelineStage) =>
    !!s.ref && (s.kind !== "excel" || (!!s.excel?.input.trim() && !!s.excel.output.file.trim()));
  const valid = draft.name.trim() && draft.stages.length > 0 && draft.stages.every(stageReady);

  return (
    <div className={`${CARD_CLASS} p-4`}>
      <div className="mb-3 flex items-center gap-2">
        <input
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="Pipeline name"
          className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 font-medium dark:border-gray-700 dark:bg-gray-950"
        />
        <button type="button" onClick={onClose} className={BTN_GHOST_CLASS}>
          Close
        </button>
      </div>
      <input
        value={draft.description}
        onChange={(e) => onChange({ ...draft, description: e.target.value })}
        placeholder="Description (optional)"
        className="mb-4 w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-950"
      />

      <ol className="space-y-3">
        {draft.stages.map((stage, i) => (
          <li key={stage.id} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-400">#{i + 1}</span>
              <select
                value={stage.kind}
                onChange={(e) => {
                  const kind = e.target.value as PipelineStageKind;
                  setStage(i, { kind, ref: "", excel: kind === "excel" ? { ...EXCEL_IO_DEFAULT } : undefined });
                }}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950"
              >
                <option value="automation">automation</option>
                <option value="script">script</option>
                <option value="excel">excel</option>
              </select>
              <select
                value={stage.ref}
                onChange={(e) => setStage(i, { ref: e.target.value })}
                className="flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950"
              >
                <option value="">— pick {stage.kind} —</option>
                {refs(stage.kind).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <Tooltip multiline content="Move this stage earlier in the run order. Stages execute top to bottom.">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="px-1 text-gray-400 disabled:opacity-30">
                  ↑
                </button>
              </Tooltip>
              <Tooltip multiline content="Move this stage later in the run order. Stages execute top to bottom.">
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === draft.stages.length - 1}
                  className="px-1 text-gray-400 disabled:opacity-30"
                >
                  ↓
                </button>
              </Tooltip>
              <Tooltip multiline content="Remove this stage from the pipeline. The automation, script, or Excel job it points to is not deleted.">
                <button type="button" onClick={() => removeStage(i)} className="px-1 text-red-500" aria-label="Remove stage">
                  ✕
                </button>
              </Tooltip>
            </div>
            <input
              value={stage.label ?? ""}
              onChange={(e) => setStage(i, { label: e.target.value })}
              placeholder="Label (optional)"
              className="mt-2 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950"
            />
            {stage.kind === "excel" && (
              <div className="mt-2 grid gap-2 rounded-md border border-gray-200 p-2 sm:grid-cols-2 dark:border-gray-700">
                <label className="text-xs text-gray-500">
                  <span className="inline-flex items-center gap-1">
                    Input file
                    <InfoHint title="Input file">
                      The spreadsheet this Excel stage reads. A bare filename is looked up in the pipeline's run directory
                      (so it can pick up a file an earlier stage dropped there); an absolute path or{" "}
                      <span className="font-mono">{"${VAR}"}</span> reference also works.
                    </InfoHint>
                  </span>
                  <input
                    value={stage.excel?.input ?? ""}
                    onChange={(e) => setExcel(i, stage, { input: e.target.value })}
                    placeholder="report.csv (run-dir file or absolute path; ${VAR} ok)"
                    className={ioField}
                  />
                </label>
                <label className="text-xs text-gray-500">
                  Sheet (xlsx input, optional)
                  <input
                    value={stage.excel?.sheet ?? ""}
                    onChange={(e) => setExcel(i, stage, { sheet: e.target.value || undefined })}
                    placeholder="(first sheet)"
                    className={ioField}
                  />
                </label>
                <label className="text-xs text-gray-500">
                  Output file
                  <input
                    value={stage.excel?.output.file ?? ""}
                    onChange={(e) => setExcelOut(i, stage, { file: e.target.value })}
                    placeholder="result.csv"
                    className={ioField}
                  />
                </label>
                <div className="flex gap-2">
                  <label className="flex-1 text-xs text-gray-500">
                    <span className="inline-flex items-center gap-1">
                      Write to
                      <InfoHint title="Write to">
                        Where this stage's output file lands. <span className="font-mono">run dir</span> keeps it in the
                        pipeline's working directory so a later stage can read it; <span className="font-mono">output
                        dir</span> publishes it as a final artifact that shows up in the Files tab.
                      </InfoHint>
                    </span>
                    <select
                      value={stage.excel?.output.to ?? "run"}
                      onChange={(e) => setExcelOut(i, stage, { to: e.target.value as "run" | "output" })}
                      className={ioField}
                    >
                      <option value="run">run dir (next stage)</option>
                      <option value="output">output dir (Files)</option>
                    </select>
                  </label>
                  <label className="flex-1 text-xs text-gray-500">
                    Format
                    <select
                      value={stage.excel?.output.format ?? "csv"}
                      onChange={(e) => setExcelOut(i, stage, { format: e.target.value as "csv" | "xlsx" })}
                      className={ioField}
                    >
                      <option value="csv">csv</option>
                      <option value="xlsx">xlsx</option>
                    </select>
                  </label>
                </div>
              </div>
            )}
            <div className="mt-2 flex items-center gap-1 text-xs text-gray-500">
              <span>With vars</span>
              <InfoHint title="With vars">
                Per-stage environment variables, one <span className="font-mono">KEY=value</span> per line, injected into
                this stage's run. Values can reference the run directory (<span className="font-mono">{"${run.dir}"}</span>)
                or any pipeline variable (<span className="font-mono">{"${VAR}"}</span>), so stages pass values and file
                paths down the chain.
              </InfoHint>
            </div>
            <textarea
              value={withToText(stage.with)}
              onChange={(e) => setStage(i, { with: textToWith(e.target.value) })}
              placeholder={"with vars, one per line:  KEY=value  (supports ${run.dir} / ${VAR})"}
              rows={2}
              className="mt-2 w-full rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-gray-700 dark:bg-gray-950"
            />
            <label className="mt-2 flex items-center gap-2 text-xs text-gray-500">
              <input
                type="checkbox"
                checked={!!stage.continueOnError}
                onChange={(e) => setStage(i, { continueOnError: e.target.checked })}
              />
              continue on error
              <InfoHint title="Continue on error">
                If this stage fails, keep running the later stages instead of stopping the whole pipeline. The run is still
                marked failed.
              </InfoHint>
            </label>
          </li>
        ))}
      </ol>

      <button
        type="button"
        onClick={() => onChange({ ...draft, stages: [...draft.stages, newStage()] })}
        className={`${BTN_GHOST_CLASS} mt-3`}
      >
        + Add stage
      </button>

      <div className="mt-4 flex items-center gap-2 border-t border-gray-200 pt-4 dark:border-gray-700">
        <button type="button" onClick={() => save.mutate()} disabled={!valid || save.isPending} className={BTN_PRIMARY_CLASS}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {draft.id && (
          <button
            type="button"
            onClick={async () => {
              if (await confirm({ prompt: "Delete this pipeline?", confirmText: "Delete" })) del.mutate();
            }}
            className={`${BTN_GHOST_CLASS} text-red-600`}
          >
            Delete
          </button>
        )}
      </div>

      {draft.id && <RunPanel pipelineId={draft.id} pipelineName={draft.name} stages={draft.stages} notify={notify} />}
    </div>
  );
}

function RunPanel({
  pipelineId,
  pipelineName,
  stages,
  notify,
}: {
  pipelineId: string;
  pipelineName: string;
  stages: PipelineStage[];
  notify: (msg: string, kind?: "success" | "error" | "info") => void;
}) {
  const { data: variables = [] } = useQuery({
    queryKey: ["pipeline-variables", pipelineId],
    queryFn: () => fetchPipelineVariables(pipelineId),
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [stageStatus, setStageStatus] = useState<Record<string, string>>({});
  const [results, setResults] = useState<PipelineStageResult[] | null>(null);

  const missing = variables.filter((v) => !v.present && !values[v.name]?.trim());

  useServerEvent((e) => {
    if (e.type === "pipeline:run:started" && e.pipeline === pipelineName) {
      setStageStatus({});
      setResults(null);
      setRunning(true);
    } else if (e.type === "pipeline:stage" && e.pipeline === pipelineName) {
      setStageStatus((s) => ({ ...s, [e.stageId]: e.status }));
    } else if (e.type === "pipeline:run:completed" && e.run.pipeline === pipelineName) {
      setRunning(false);
      setResults(e.run.stages);
      notify(e.run.status === "passed" ? "Pipeline passed" : "Pipeline failed", e.run.status === "passed" ? "success" : "error");
    }
  });

  const run = async () => {
    const supplied: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (v.trim()) supplied[k] = v;
    setRunning(true);
    setResults(null);
    try {
      await runPipeline({ id: pipelineId, variables: supplied });
    } catch (err) {
      setRunning(false);
      notify(err instanceof Error ? err.message : "run failed", "error");
    }
  };

  const dot = (status?: string) =>
    status === "passed" ? "bg-green-500" : status === "failed" ? "bg-red-500" : status === "running" ? "bg-amber-400 animate-pulse" : status === "skipped" ? "bg-gray-300" : "bg-gray-200 dark:bg-gray-700";

  return (
    <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
      {variables.length > 0 && (
        <div className="mb-3">
          <div className="mb-2 text-xs font-semibold tracking-wide text-gray-400 uppercase">Variables</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {variables.map((v) => (
              <label key={v.name} className="block text-sm">
                <span className="font-mono text-xs text-gray-600 dark:text-gray-400">
                  {v.name} {v.present ? <span className="text-green-600 dark:text-green-400">✓ set</span> : <span className="text-amber-500">required</span>}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  value={values[v.name] ?? ""}
                  onChange={(e) => setValues((s) => ({ ...s, [v.name]: e.target.value }))}
                  placeholder={v.present ? "set in .env — type to override" : "required"}
                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-950"
                />
              </label>
            ))}
          </div>
        </div>
      )}

      <Tooltip
        multiline
        content="Run every stage of this pipeline in order, live — stage dots light up as each runs. Any required variables above must be supplied first (or set in .env)."
      >
        <button
          type="button"
          onClick={run}
          disabled={running || missing.length > 0}
          className={BTN_PRIMARY_CLASS}
        >
          {running ? "Running…" : "▶ Run pipeline"}
        </button>
      </Tooltip>

      <ol className="mt-3 space-y-1">
        {stages.map((stage) => {
          const result = results?.find((r) => r.stageId === stage.id);
          const status = result?.status ?? stageStatus[stage.id];
          return (
            <li key={stage.id} className="text-sm">
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot(status)}`} />
                <span>{stage.label?.trim() || `${stage.kind}:${stage.ref}`}</span>
                {result?.error && <span className="text-xs text-red-500">— {result.error}</span>}
              </div>
              {result?.output && (
                <pre className="mt-1 ml-4.5 max-h-40 overflow-auto rounded bg-gray-950 p-2 text-[11px] text-gray-100">
                  {result.output}
                </pre>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
