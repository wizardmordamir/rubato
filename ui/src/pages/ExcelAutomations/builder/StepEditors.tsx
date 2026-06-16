import type {
  AddColumnStep,
  AutomationStep,
  CellScalar,
  ColumnRef,
  ComparisonOp,
  Condition,
  ConditionGroup,
  FillColumnStep,
  FilterColumnsStep,
  FilterKeep,
  FilterRowsStep,
  KeepSheetStep,
  LimitRowsStep,
  ManualEditStep,
  RenameColumnStep,
  SortRowsStep,
  StepType,
} from "cwip/excel-engine/types";
import { COMPARISON_OP_LABEL, COMPARISON_OPS, DATE_OPS, UNARY_OPS } from "cwip/excel-engine/types";
import type { ReactElement } from "react";
import { Dropdown, FIELD_CLASS, Tooltip } from "../../../components";
import { useBuilder } from "./model";

const cls = FIELD_CLASS;

export type EditorProps<T extends AutomationStep = AutomationStep> = {
  step: T;
  onChange: (step: T) => void;
};

// ── shared building blocks ────────────────────────────────────────────────────

const ColumnPicker = ({
  value,
  onChange,
  placeholder = "Select column…",
}: {
  value?: ColumnRef;
  onChange: (ref: ColumnRef) => void;
  placeholder?: string;
}) => {
  const { columns } = useBuilder();
  const current = value?.byHeader ?? "";
  if (columns.length === 0) {
    return (
      <input
        className={cls}
        value={current}
        placeholder="Column name"
        onChange={(e) => onChange({ byHeader: e.target.value })}
      />
    );
  }
  return (
    <Dropdown
      aria-label="Column"
      classNames={{ root: "block w-full", trigger: () => `${cls} flex items-center justify-between gap-2` }}
      placeholder={placeholder}
      value={current || null}
      onChange={(v) => onChange({ byHeader: v })}
      options={columns.map((c) => ({ value: c.title, label: c.title }))}
    />
  );
};

// Treat a ConditionGroup as { combinator, conditions } for editing.
const readGroup = (g: ConditionGroup | undefined): { combinator: "all" | "any"; conditions: Condition[] } =>
  g?.any ? { combinator: "any", conditions: g.any } : { combinator: "all", conditions: g?.all ?? [] };
const writeGroup = (combinator: "all" | "any", conditions: Condition[]): ConditionGroup =>
  combinator === "any" ? { any: conditions } : { all: conditions };

const ConditionRow = ({
  cond,
  onChange,
  onRemove,
}: {
  cond: Condition;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) => {
  const isUnary = UNARY_OPS.includes(cond.op);
  const isDate = DATE_OPS.includes(cond.op);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <div className="min-w-[8rem] flex-1">
        <ColumnPicker value={cond.column} onChange={(column) => onChange({ ...cond, column })} />
      </div>
      <Dropdown
        aria-label="Comparison"
        className={`${cls} w-auto`}
        value={cond.op}
        onChange={(v) => onChange({ ...cond, op: v as ComparisonOp })}
        options={COMPARISON_OPS.map((op) => ({ value: op, label: COMPARISON_OP_LABEL[op] }))}
      />
      {!isUnary && (
        <input
          className={`${cls} w-32`}
          type="text"
          placeholder={isDate ? "YYYY-MM-DD or today / -30d" : "value"}
          value={cond.value == null ? "" : String(cond.value)}
          onChange={(e) => onChange({ ...cond, value: e.target.value })}
        />
      )}
      <Tooltip content="Remove this condition">
        <button type="button" className="px-1 text-neutral-400 hover:text-red-500" onClick={onRemove}>
          ✕
        </button>
      </Tooltip>
    </div>
  );
};

const ComparisonEditor = ({
  group,
  onChange,
}: {
  group: ConditionGroup | undefined;
  onChange: (g: ConditionGroup) => void;
}) => {
  const { combinator, conditions } = readGroup(group);
  const setConditions = (next: Condition[]) => onChange(writeGroup(combinator, next));
  return (
    <div className="space-y-1 rounded border border-neutral-200 p-2 dark:border-neutral-700">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-neutral-500">Match</span>
        <Dropdown
          aria-label="Match combinator"
          className={`${cls} w-auto`}
          value={combinator}
          onChange={(v) => onChange(writeGroup(v as "all" | "any", conditions))}
          options={[
            { value: "all", label: "all (AND)" },
            { value: "any", label: "any (OR)" },
          ]}
        />
        <span className="text-neutral-500">of:</span>
      </div>
      {conditions.map((c, i) => (
        <ConditionRow
          // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no stable id
          key={i}
          cond={c}
          onChange={(next) => setConditions(conditions.map((x, j) => (j === i ? next : x)))}
          onRemove={() => setConditions(conditions.filter((_, j) => j !== i))}
        />
      ))}
      <button
        type="button"
        className="text-xs text-accent hover:underline"
        onClick={() => setConditions([...conditions, { column: {}, op: "eq", value: "" }])}
      >
        + Add condition
      </button>
    </div>
  );
};

const ModeToggle = ({
  mode,
  onChange,
}: {
  mode: "hide" | "delete";
  onChange: (m: "hide" | "delete") => void;
}) => (
  <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
    Matched rows/cols:
    <Dropdown
      aria-label="Matched rows/cols mode"
      className={`${cls} w-auto`}
      value={mode}
      onChange={(v) => onChange(v as "hide" | "delete")}
      options={[
        { value: "hide", label: "hide (keep)" },
        { value: "delete", label: "delete" },
      ]}
    />
  </label>
);

// ── per-type editors ──────────────────────────────────────────────────────────

const KeepSheetEditor = ({ step, onChange }: EditorProps<KeepSheetStep>) => {
  const { sheets } = useBuilder();
  const byName = step.which.name != null;
  return (
    <div className="space-y-1 text-xs">
      <div className="flex items-center gap-2">
        <Dropdown
          aria-label="Sheet selector"
          className={`${cls} w-auto`}
          value={byName ? "name" : "index"}
          onChange={(v) =>
            onChange({
              ...step,
              which: v === "name" ? { name: sheets[0]?.name ?? "" } : { index: 0 },
            })
          }
          options={[
            { value: "index", label: "by position" },
            { value: "name", label: "by name" },
          ]}
        />
        {byName ? (
          sheets.length ? (
            <Dropdown
              aria-label="Sheet name"
              classNames={{ root: "block w-full", trigger: () => `${cls} flex items-center justify-between gap-2` }}
              value={step.which.name ?? null}
              onChange={(v) => onChange({ ...step, which: { name: v } })}
              options={sheets.map((s) => ({ value: s.name, label: s.name }))}
            />
          ) : (
            <input
              className={cls}
              placeholder="Sheet name"
              value={step.which.name ?? ""}
              onChange={(e) => onChange({ ...step, which: { name: e.target.value } })}
            />
          )
        ) : (
          <input
            className={`${cls} w-24`}
            type="number"
            min={1}
            value={(step.which.index ?? 0) + 1}
            onChange={(e) => onChange({ ...step, which: { index: Math.max(0, Number(e.target.value) - 1) } })}
          />
        )}
      </div>
      <p className="text-neutral-400">Deletes every other worksheet.</p>
    </div>
  );
};

const FilterRowsEditor = ({ step, onChange }: EditorProps<FilterRowsStep>) => {
  // Absent `keep` means a pre-this-feature step, which kept the non-matching rows.
  const keep: FilterKeep = step.keep ?? "nonMatching";
  return (
    <div className="space-y-2 text-xs">
      <ComparisonEditor group={step.where} onChange={(where) => onChange({ ...step, where })} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-neutral-600 dark:text-neutral-300">
          Keep rows that
          <Dropdown
            aria-label="Keep rows that"
            className={`${cls} w-auto`}
            value={keep}
            onChange={(v) => onChange({ ...step, keep: v as FilterKeep })}
            options={[
              { value: "matching", label: "match" },
              { value: "nonMatching", label: "don't match" },
            ]}
          />
        </label>
        <label className="flex items-center gap-2 text-neutral-600 dark:text-neutral-300">
          and
          <Dropdown
            aria-label="Apply to the rest"
            className={`${cls} w-auto`}
            value={step.mode}
            onChange={(v) => onChange({ ...step, mode: v as FilterRowsStep["mode"] })}
            options={[
              { value: "hide", label: "hide" },
              { value: "delete", label: "delete" },
            ]}
          />
          the rest
        </label>
        <label className="flex items-center gap-1 text-neutral-500">
          <input
            type="checkbox"
            checked={step.hasHeader}
            onChange={(e) => onChange({ ...step, hasHeader: e.target.checked })}
          />
          first row is a header
        </label>
      </div>
    </div>
  );
};

const LimitRowsEditor = ({ step, onChange }: EditorProps<LimitRowsStep>) => (
  <div className="flex flex-wrap items-center gap-3 text-xs">
    <label className="flex items-center gap-2 text-neutral-600 dark:text-neutral-300">
      Keep the first
      <input
        type="number"
        min={0}
        className={`${cls} w-20`}
        value={step.count}
        onChange={(e) => onChange({ ...step, count: Math.max(0, Number(e.target.value) || 0) })}
      />
      rows and
      <Dropdown
        aria-label="Apply to the rest"
        className={`${cls} w-auto`}
        value={step.mode}
        onChange={(v) => onChange({ ...step, mode: v as LimitRowsStep["mode"] })}
        options={[
          { value: "delete", label: "delete" },
          { value: "hide", label: "hide" },
        ]}
      />
      the rest
    </label>
    <label className="flex items-center gap-1 text-neutral-500">
      <input
        type="checkbox"
        checked={step.hasHeader}
        onChange={(e) => onChange({ ...step, hasHeader: e.target.checked })}
      />
      first row is a header
    </label>
  </div>
);

const RenameColumnEditor = ({ step, onChange }: EditorProps<RenameColumnStep>) => (
  <div className="flex items-center gap-2 text-xs">
    <div className="flex-1">
      <ColumnPicker value={step.column} onChange={(column) => onChange({ ...step, column })} />
    </div>
    <span className="text-neutral-400">→</span>
    <input
      className={cls}
      placeholder="New name"
      value={step.to}
      onChange={(e) => onChange({ ...step, to: e.target.value })}
    />
  </div>
);

const SortRowsEditor = ({ step, onChange }: EditorProps<SortRowsStep>) => {
  const setKey = (i: number, patch: Partial<SortRowsStep["by"][number]>) =>
    onChange({ ...step, by: step.by.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  return (
    <div className="space-y-1 text-xs">
      {step.by.map((k, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sort keys have no stable id
        <div key={i} className="flex items-center gap-1">
          <div className="flex-1">
            <ColumnPicker value={k.column} onChange={(column) => setKey(i, { column })} />
          </div>
          <Dropdown
            aria-label="Sort direction"
            className={`${cls} w-auto`}
            value={k.dir}
            onChange={(v) => setKey(i, { dir: v as "asc" | "desc" })}
            options={[
              { value: "asc", label: "A→Z" },
              { value: "desc", label: "Z→A" },
            ]}
          />
          <Tooltip content="Remove this sort column">
            <button
              type="button"
              className="px-1 text-neutral-400 hover:text-red-500"
              onClick={() => onChange({ ...step, by: step.by.filter((_, j) => j !== i) })}
            >
              ✕
            </button>
          </Tooltip>
        </div>
      ))}
      <button
        type="button"
        className="text-accent hover:underline"
        onClick={() => onChange({ ...step, by: [...step.by, { column: {}, dir: "asc" }] })}
      >
        + Add sort column
      </button>
    </div>
  );
};

const FilterColumnsEditor = ({ step, onChange }: EditorProps<FilterColumnsStep>) => {
  const { columns } = useBuilder();
  const dropSet = new Set((step.drop ?? []).map((r) => r.byHeader));
  const toggle = (title: string) => {
    const next = dropSet.has(title)
      ? (step.drop ?? []).filter((r) => r.byHeader !== title)
      : [...(step.drop ?? []), { byHeader: title }];
    onChange({ ...step, drop: next });
  };
  return (
    <div className="space-y-2 text-xs">
      <p className="text-neutral-500">Columns to remove:</p>
      {columns.length ? (
        <div className="flex flex-wrap gap-1">
          {columns.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => toggle(c.title)}
              className={`rounded px-2 py-0.5 ${
                dropSet.has(c.title)
                  ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300"
              }`}
            >
              {c.title}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-neutral-400">Run or step to load columns first.</p>
      )}
      <ModeToggle mode={step.mode} onChange={(mode) => onChange({ ...step, mode })} />
    </div>
  );
};

const AddColumnEditor = ({ step, onChange }: EditorProps<AddColumnStep>) => (
  <div className="space-y-1 text-xs">
    <input
      className={cls}
      placeholder="New column name (e.g. Needs Review)"
      value={step.header}
      onChange={(e) => onChange({ ...step, header: e.target.value })}
    />
    <input
      className={cls}
      placeholder="Initial value (optional)"
      value={step.initialValue == null ? "" : String(step.initialValue)}
      onChange={(e) => onChange({ ...step, initialValue: e.target.value })}
    />
  </div>
);

const FillColumnEditor = ({ step, onChange }: EditorProps<FillColumnStep>) => {
  const mode = step.formula != null ? "formula" : "derived";
  const setRule = (i: number, patch: Partial<NonNullable<FillColumnStep["rules"]>[number]>) =>
    onChange({
      ...step,
      rules: (step.rules ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)),
    });
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-neutral-500">Target</span>
        <div className="flex-1">
          <ColumnPicker value={step.target} onChange={(target) => onChange({ ...step, target })} />
        </div>
      </div>
      <Dropdown
        aria-label="Fill mode"
        className={`${cls} w-auto`}
        value={mode}
        onChange={(v) =>
          v === "formula"
            ? onChange({ ...step, formula: "", rules: undefined })
            : onChange({ ...step, formula: undefined, rules: [] })
        }
        options={[
          { value: "derived", label: "by comparison rules" },
          { value: "formula", label: "by Excel formula" },
        ]}
      />

      {mode === "formula" ? (
        <div className="space-y-1">
          <input
            className={`${cls} font-mono`}
            placeholder="=SUM(A2:A100) or =B2*C2"
            value={step.formula ?? ""}
            onChange={(e) => onChange({ ...step, formula: e.target.value })}
          />
          <label className="flex items-center gap-1 text-neutral-500">
            <input
              type="checkbox"
              checked={!!step.formulaPerRow}
              onChange={(e) => onChange({ ...step, formulaPerRow: e.target.checked })}
            />
            apply per row (relative references adjust)
          </label>
        </div>
      ) : (
        <div className="space-y-2">
          {(step.rules ?? []).map((rule, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rules have no stable id
            <div key={i} className="space-y-1 rounded border border-neutral-200 p-1 dark:border-neutral-700">
              <ComparisonEditor group={rule.when} onChange={(when) => setRule(i, { when })} />
              <div className="flex items-center gap-2">
                <span className="text-neutral-500">set to</span>
                <input
                  className={`${cls} w-32`}
                  placeholder="value (e.g. true)"
                  value={rule.set == null ? "" : String(rule.set)}
                  onChange={(e) => setRule(i, { set: coerce(e.target.value) })}
                />
                <Tooltip content="Remove this rule">
                  <button
                    type="button"
                    className="text-neutral-400 hover:text-red-500"
                    onClick={() => onChange({ ...step, rules: (step.rules ?? []).filter((_, j) => j !== i) })}
                  >
                    ✕
                  </button>
                </Tooltip>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() =>
              onChange({
                ...step,
                rules: [...(step.rules ?? []), { when: { all: [] }, set: true }],
              })
            }
          >
            + Add rule
          </button>
          <div className="flex items-center gap-2">
            <span className="text-neutral-500">otherwise</span>
            <input
              className={`${cls} w-32`}
              placeholder="else value"
              value={step.elseValue == null ? "" : String(step.elseValue)}
              onChange={(e) => onChange({ ...step, elseValue: coerce(e.target.value) })}
            />
          </div>
        </div>
      )}
    </div>
  );
};

const ManualEditEditor = ({ step }: EditorProps<ManualEditStep>) => (
  <p className="text-xs text-neutral-500">
    Step onto this in Debug mode to edit cells directly in the grid. Recorded edits:{" "}
    <span className="font-mono">{step.edits.length}</span>
  </p>
);

// Coerce a string input into boolean/number where it clearly is one.
const coerce = (raw: string): CellScalar => {
  const t = raw.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return raw;
};

export const STEP_EDITORS: Record<StepType, (props: EditorProps<any>) => ReactElement> = {
  keepSheet: KeepSheetEditor,
  filterRows: FilterRowsEditor,
  limitRows: LimitRowsEditor,
  sortRows: SortRowsEditor,
  filterColumns: FilterColumnsEditor,
  renameColumn: RenameColumnEditor,
  addColumn: AddColumnEditor,
  fillColumn: FillColumnEditor,
  manualEdit: ManualEditEditor,
};
