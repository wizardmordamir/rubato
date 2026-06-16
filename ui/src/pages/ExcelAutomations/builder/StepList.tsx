import type { AutomationStep, StepResult, StepType } from "cwip/excel-engine/types";
import { InfoHint } from "cwip/react";
import { Dropdown, FIELD_CLASS, Tooltip } from "../../../components";
import { newStep, STEP_TYPE_LABEL, STEP_TYPES } from "./model";
import { STEP_EDITORS } from "./StepEditors";

// One-line plain-English explanation of what each step type does to the sheet.
const STEP_TYPE_HELP: Record<StepType, string> = {
  keepSheet: "Keeps only the chosen worksheet and deletes every other one in the workbook.",
  filterRows: "Keeps the rows that match (or don't match) your conditions, hiding or deleting the rest.",
  limitRows: "Keeps only the first N data rows, hiding or deleting everything past that.",
  sortRows: "Reorders the rows by one or more columns, ascending or descending.",
  filterColumns: "Removes (or keeps only) the columns you pick.",
  renameColumn: "Changes a column's header text to a new name.",
  addColumn: "Appends a new column with an optional starting value in every row.",
  fillColumn: "Sets a column's values — either by an Excel formula or by comparison rules (when X, set Y; otherwise Z).",
  manualEdit: "Records cell edits you make by hand in the grid during Debug, replayed as a step.",
};

const STATUS_DOT: Record<StepResult["status"] | "idle", string> = {
  idle: "bg-neutral-300",
  ok: "bg-emerald-500",
  error: "bg-red-500",
  skipped: "bg-neutral-400",
};

const StepDiagnostics = ({ result }: { result: StepResult }) => (
  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-500">
    <span>{result.durationMs} ms</span>
    {result.rowsAffected > 0 && <span>{result.rowsAffected} rows</span>}
    {result.colsAffected > 0 && <span>{result.colsAffected} cols</span>}
    {result.sheetsAffected > 0 && <span>{result.sheetsAffected} sheets</span>}
    {result.error && <span className="text-red-500">{result.error}</span>}
  </div>
);

const StepRow = ({
  step,
  index,
  result,
  isCurrent,
  onChange,
  onRemove,
  onMove,
}: {
  step: AutomationStep;
  index: number;
  result?: StepResult;
  isCurrent: boolean;
  onChange: (s: AutomationStep) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) => {
  const Editor = STEP_EDITORS[step.type];
  return (
    <div
      className={`rounded-lg border p-2 ${
        isCurrent
          ? "border-accent ring-1 ring-accent/40"
          : "border-neutral-200 dark:border-neutral-700"
      } ${step.enabled === false ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[result?.status ?? "idle"]}`} />
        <span className="w-5 shrink-0 text-center text-xs text-neutral-400">{index + 1}</span>
        <Dropdown
          aria-label="Step type"
          classNames={{ root: "block flex-1", trigger: () => `${FIELD_CLASS} flex items-center justify-between gap-2` }}
          value={step.type}
          onChange={(v) => onChange(newStep(v as StepType))}
          options={STEP_TYPES.map((t) => ({ value: t, label: STEP_TYPE_LABEL[t] }))}
        />
        <InfoHint title={STEP_TYPE_LABEL[step.type]}>{STEP_TYPE_HELP[step.type]}</InfoHint>
        <Tooltip content={step.enabled === false ? "Step is disabled — won't run" : "Step is enabled"}>
          <label className="flex items-center gap-1 text-[11px] text-neutral-400">
            <input
              type="checkbox"
              checked={step.enabled !== false}
              onChange={(e) => onChange({ ...step, enabled: e.target.checked })}
            />
          </label>
        </Tooltip>
        <Tooltip content="Move step up">
          <button type="button" className="px-1 text-neutral-400 hover:text-neutral-700" onClick={() => onMove(-1)}>
            ↑
          </button>
        </Tooltip>
        <Tooltip content="Move step down">
          <button type="button" className="px-1 text-neutral-400 hover:text-neutral-700" onClick={() => onMove(1)}>
            ↓
          </button>
        </Tooltip>
        <Tooltip content="Delete this step">
          <button type="button" className="px-1 text-neutral-400 hover:text-red-500" onClick={onRemove}>
            ✕
          </button>
        </Tooltip>
      </div>
      <div className="mt-2 pl-9">
        <Editor step={step} onChange={onChange} />
        {result && <StepDiagnostics result={result} />}
      </div>
    </div>
  );
};

export const StepList = ({
  steps,
  onChange,
  results,
  currentIndex,
}: {
  steps: AutomationStep[];
  onChange: (steps: AutomationStep[]) => void;
  results: Record<number, StepResult>;
  currentIndex?: number;
}) => {
  const update = (i: number, s: AutomationStep) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const remove = (i: number) => onChange(steps.filter((_, j) => j !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const copy = steps.slice();
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  };
  return (
    <div className="space-y-2">
      {steps.map((step, i) => (
        <StepRow
          key={step.id}
          step={step}
          index={i}
          result={results[i]}
          isCurrent={currentIndex === i}
          onChange={(s) => update(i, s)}
          onRemove={() => remove(i)}
          onMove={(dir) => move(i, dir)}
        />
      ))}
      <Dropdown
        aria-label="Add step"
        classNames={{
          root: "block w-full",
          trigger: () => `${FIELD_CLASS} flex items-center justify-between gap-2 border-dashed text-neutral-500`,
        }}
        placeholder="+ Add step…"
        value={null}
        onChange={(v) => onChange([...steps, newStep(v as StepType)])}
        options={STEP_TYPES.map((t) => ({ value: t, label: STEP_TYPE_LABEL[t] }))}
      />
    </div>
  );
};
