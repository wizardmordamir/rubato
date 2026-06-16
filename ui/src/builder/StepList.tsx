import type { ActionType, Condition, Step, StepParams } from "@shared/automation";
import { DropIndicator, useDragReorder } from "cwip/react";
import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useState } from "react";
import type { StepResult } from "../api";
import { Dropdown, OpenPathButton, Tooltip } from "../components";
import { IconCopy, IconEye, IconEyeOff, IconGrip, IconPlus } from "../icons";
import { ACTIONS, actionSpec, cloneStep, newStep, type ParamField, stepNeedsTarget } from "./model";
import { TargetEditor } from "./TargetEditor";

const input =
  "rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30 dark:border-gray-700 dark:bg-gray-900";

/** Per-step run statuses keyed by dotted index, e.g. "2" or "2.then.0". */
export type ResultMap = Record<string, StepResult>;

interface ListProps {
  steps: Step[];
  onChange: (steps: Step[]) => void;
  results: ResultMap;
  /** Dotted index prefix for this (possibly nested) list. */
  prefix?: string;
}

export function StepList({ steps, onChange, results, prefix = "" }: ListProps) {
  const update = (i: number, step: Step) => onChange(steps.map((s, idx) => (idx === i ? step : s)));
  const remove = (i: number) => onChange(steps.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const copy = steps.slice();
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  };
  // `at` is a boundary index 0..length (between/around rows).
  const insertAt = (at: number, step: Step) => onChange([...steps.slice(0, at), step, ...steps.slice(at)]);
  const clone = (i: number) => onChange([...steps.slice(0, i + 1), cloneStep(steps[i]), ...steps.slice(i + 1)]);

  // Pointer drag-reorder via the shared engine (gap preview + no dead zones). Each
  // StepList instance — including nested if-branches — has its own engine, so a
  // drag still only reorders within the list it started in.
  const { containerProps, getItemProps, getHandleProps } = useDragReorder({
    ids: steps.map((s) => s.id),
    onReorder: (nextIds) => {
      const byId = new Map(steps.map((s) => [s.id, s]));
      onChange(nextIds.map((id) => byId.get(id)).filter((s): s is Step => Boolean(s)));
    },
  });

  return (
    <div {...containerProps}>
      {steps.map((step, i) => {
        const { isDragging, insertBefore, insertAfter, style, ...itemRest } = getItemProps(step.id);
        return (
          <div key={step.id} {...itemRest} style={style} className="relative">
            <InsertBoundary onInsert={() => insertAt(i, newStep("click"))} />
            {insertBefore && <DropIndicator orientation="horizontal" side="start" />}
            <StepRow
              step={step}
              index={prefix ? `${prefix}.${i}` : String(i)}
              results={results}
              handleProps={getHandleProps(step.id)}
              onChange={(s) => update(i, s)}
              onRemove={() => remove(i)}
              onClone={() => clone(i)}
              onUp={() => move(i, -1)}
              onDown={() => move(i, 1)}
            />
            {insertAfter && <DropIndicator orientation="horizontal" side="end" />}
          </div>
        );
      })}
      <InsertBoundary onInsert={() => insertAt(steps.length, newStep("click"))} />
      <AddStep onAdd={(a) => onChange([...steps, newStep(a)])} />
    </div>
  );
}

/**
 * The space between two steps (and above the first): a thin hover "+" to insert a
 * step at this boundary. Reordering is handled by the shared drag engine, which
 * draws its own insertion line, so this is purely the insert affordance.
 */
function InsertBoundary({ onInsert }: { onInsert: () => void }) {
  return (
    <div className="group flex h-3 items-center justify-center">
      <Tooltip content="Insert a step here">
        <button
          type="button"
          onClick={onInsert}
          aria-label="Insert a step here"
          className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-gray-300 text-gray-400 opacity-0 transition group-hover:opacity-100 hover:border-accent hover:text-accent dark:border-gray-700"
        >
          <IconPlus size={12} />
        </button>
      </Tooltip>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  running: "bg-amber-400",
  passed: "bg-emerald-500",
  failed: "bg-red-500",
  skipped: "bg-gray-400",
};

function StepRow({
  step,
  index,
  results,
  handleProps,
  onChange,
  onRemove,
  onClone,
  onUp,
  onDown,
}: {
  step: Step;
  index: string;
  results: ResultMap;
  handleProps: { style: CSSProperties; onPointerDown: (e: ReactPointerEvent) => void };
  onChange: (s: Step) => void;
  onRemove: () => void;
  onClone: () => void;
  onUp: () => void;
  onDown: () => void;
}) {
  const spec = actionSpec(step.action);
  const result = results[index];
  const setParam = (patch: Partial<StepParams>) => onChange({ ...step, params: { ...step.params, ...patch } });

  return (
    <div className="rounded border border-gray-200 p-2 dark:border-gray-800">
      <div className="flex items-center gap-2">
        {/* Only the grip starts a drag, so the row's inputs stay usable. */}
        <Tooltip content="Drag to reorder" className="shrink-0">
          <span {...handleProps} className="text-gray-300 hover:text-gray-500 dark:text-gray-600">
            <IconGrip size={16} />
          </span>
        </Tooltip>
        {result && (
          <Tooltip content={result.status} className="shrink-0">
            <span className={`block h-2 w-2 rounded-full ${STATUS_COLOR[result.status] ?? "bg-gray-300"}`} />
          </Tooltip>
        )}
        <span className="font-mono text-xs text-gray-400">{index}</span>
        <Dropdown
          aria-label="Step action"
          value={step.action}
          onChange={(v) => onChange({ ...newStep(v as ActionType), id: step.id })}
          options={ACTIONS.map((a) => ({ value: a.value, label: a.label }))}
        />
        {spec.fields.map((f) => (
          <ParamInput key={f} field={f} action={step.action} params={step.params ?? {}} onChange={setParam} />
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip content="Don't fail the run if this step fails">
            <label className="flex items-center gap-1 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={!!step.options?.optional}
                onChange={(e) => onChange({ ...step, options: { ...step.options, optional: e.target.checked || undefined } })}
              />
              opt
            </label>
          </Tooltip>
          <IconBtn onClick={onClone} title="Clone this step">
            <IconCopy size={13} />
          </IconBtn>
          <IconBtn onClick={onUp} title="Move up">
            ↑
          </IconBtn>
          <IconBtn onClick={onDown} title="Move down">
            ↓
          </IconBtn>
          <IconBtn onClick={onRemove} title="Delete step">
            ✕
          </IconBtn>
        </div>
      </div>

      {step.action === "if" ? (
        <ConditionEditor step={step} index={index} results={results} onChange={onChange} />
      ) : (
        stepNeedsTarget(step) && (
          <div className="mt-2">
            <TargetEditor
              target={step.target ?? { kind: "testid", value: "" }}
              onChange={(t) => onChange({ ...step, target: t })}
            />
          </div>
        )
      )}

      {result && <StepDiagnostics result={result} />}
    </div>
  );
}

/** Inline-serve URL for a captured artifact (output-dir-relative path). */
const rawHref = (path: string) => `/api/files/raw?path=${encodeURIComponent(path)}`;

/**
 * The per-step debug readout: timing + match count, where the page ended up,
 * the failure message, scraped value, captured browser logs, and — for a
 * `snapshot` step or a failed step — the captured page image + HTML, persisted
 * so previous runs keep them. Shows what went well and what didn't.
 */
export function StepDiagnostics({ result }: { result: StepResult }) {
  if (result.status === "running") return null;
  const meta: string[] = [`${result.durationMs}ms`];
  if (result.matchCount != null) meta.push(`${result.matchCount} match${result.matchCount === 1 ? "" : "es"}`);
  // A snapshot step's captures are deliberate; a failed step's are the page that broke.
  const isSnapshot = result.action === "snapshot";
  const shotSrc = result.screenshotPath ? rawHref(result.screenshotPath) : result.screenshot;

  return (
    <div className="mt-1 space-y-1">
      <div className="font-mono text-xs text-gray-400">{meta.join(" · ")}</div>
      {result.finalUrl && (
        <Tooltip content={result.finalUrl}>
          <div className="truncate font-mono text-xs text-gray-400">
            → {result.finalUrl}
          </div>
        </Tooltip>
      )}
      {result.error && <div className="font-mono text-xs whitespace-pre-wrap text-red-500">{result.error}</div>}
      {result.scraped && (
        <div className="font-mono text-xs text-emerald-600">
          {result.scraped.name} = {result.scraped.value}
        </div>
      )}
      {/* saveFile/screenshot stash their written path in `selector`. */}
      {(result.action === "saveFile" || result.action === "screenshot") && result.selector && (
        <Tooltip content={result.selector}>
          <div className="font-mono text-xs text-emerald-600">
            wrote <span className="break-all">{result.selector}</span>
            <OpenPathButton path={result.selector} />
          </div>
        </Tooltip>
      )}
      {result.logs && result.logs.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-gray-400">browser logs ({result.logs.length})</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-gray-100 p-2 font-mono text-xs whitespace-pre-wrap text-gray-600 dark:bg-gray-800/70 dark:text-gray-300">
            {result.logs.join("\n")}
          </pre>
        </details>
      )}
      {shotSrc && (
        <details>
          <summary className="cursor-pointer text-xs text-gray-400">
            {isSnapshot ? "snapshot image" : "screenshot at failure"}
          </summary>
          {result.screenshotPath && (
            <div className="mt-1">
              <OpenPathButton path={result.screenshotPath} />
            </div>
          )}
          <a href={shotSrc} target="_blank" rel="noreferrer">
            <img
              src={shotSrc}
              alt={isSnapshot ? "snapshot" : "page at failure"}
              className="mt-1 max-h-64 rounded border border-gray-200 dark:border-gray-800"
            />
          </a>
        </details>
      )}
      {result.htmlPath && (
        <details>
          <summary className="cursor-pointer text-xs text-gray-400">{isSnapshot ? "snapshot HTML" : "HTML at failure"}</summary>
          <div className="mt-1">
            <a href={rawHref(result.htmlPath)} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent hover:underline">
              open captured HTML ↗
            </a>
            <OpenPathButton path={result.htmlPath} />
            {/* Sandboxed: the captured DOM's inline scripts must not run in our origin. */}
            <iframe
              title="captured HTML"
              src={rawHref(result.htmlPath)}
              sandbox=""
              className="mt-1 h-64 w-full rounded border border-gray-200 bg-white dark:border-gray-800"
            />
          </div>
        </details>
      )}
    </div>
  );
}

function ConditionEditor({
  step,
  index,
  results,
  onChange,
}: {
  step: Step;
  index: string;
  results: ResultMap;
  onChange: (s: Step) => void;
}) {
  const cond: Condition = step.condition ?? { kind: "selector-visible" };
  const setCond = (patch: Partial<Condition>) => onChange({ ...step, condition: { ...cond, ...patch } });
  return (
    <div className="mt-2 space-y-2 border-l-2 border-gray-200 pl-3 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <Dropdown
          aria-label="Condition"
          value={cond.kind}
          onChange={(v) => setCond({ kind: v as Condition["kind"] })}
          options={[
            { value: "selector-visible", label: "element is visible" },
            { value: "selector-hidden", label: "element is hidden" },
            { value: "url-matches", label: "URL matches" },
          ]}
        />
        {cond.kind === "url-matches" && (
          <input
            value={cond.value ?? ""}
            onChange={(e) => setCond({ value: e.target.value })}
            placeholder="/login  or  /regex/i"
            className={`${input} flex-1`}
          />
        )}
      </div>
      {(cond.kind === "selector-visible" || cond.kind === "selector-hidden") && (
        <TargetEditor target={cond.target ?? { kind: "testid", value: "" }} onChange={(t) => setCond({ target: t })} />
      )}
      <div>
        <div className="mb-1 text-xs font-semibold text-gray-500">then</div>
        <StepList
          steps={step.thenSteps ?? []}
          onChange={(s) => onChange({ ...step, thenSteps: s })}
          results={results}
          prefix={`${index}.then`}
        />
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold text-gray-500">else</div>
        <StepList
          steps={step.elseSteps ?? []}
          onChange={(s) => onChange({ ...step, elseSteps: s })}
          results={results}
          prefix={`${index}.else`}
        />
      </div>
    </div>
  );
}

function ParamInput({
  field,
  action,
  params,
  onChange,
}: {
  field: ParamField;
  action: ActionType;
  params: StepParams;
  onChange: (patch: Partial<StepParams>) => void;
}) {
  if (field === "waitKind") {
    return (
      <Dropdown
        aria-label="Wait until"
        value={params.waitKind ?? "ms"}
        onChange={(v) => onChange({ waitKind: v as StepParams["waitKind"] })}
        options={[
          { value: "ms", label: "for ms" },
          { value: "load", label: "page load" },
          { value: "networkidle", label: "network idle" },
          { value: "visible", label: "element visible" },
          { value: "hidden", label: "element hidden" },
        ]}
      />
    );
  }
  if (field === "ms") {
    if (params.waitKind && params.waitKind !== "ms") return null;
    return (
      <input
        type="number"
        value={params.ms ?? 1000}
        onChange={(e) => onChange({ ms: Number(e.target.value) })}
        className={`${input} w-20`}
        placeholder="ms"
      />
    );
  }
  if (field === "count") {
    const isTab = action === "switchTab";
    return (
      <Tooltip content={isTab ? "tab index (0-based)" : "expected count"}>
        <input
          type="number"
          value={params.count ?? (isTab ? 0 : 1)}
          onChange={(e) => onChange({ count: Number(e.target.value) })}
          className={`${input} w-16`}
          placeholder={isTab ? "tab #" : undefined}
        />
      </Tooltip>
    );
  }
  if (field === "dialogAction") {
    return (
      <Tooltip content="What to do with the next native dialog">
        <Dropdown
          aria-label="On dialog"
          value={params.dialogAction ?? "accept"}
          onChange={(v) => onChange({ dialogAction: v as StepParams["dialogAction"] })}
          options={[
            { value: "accept", label: "accept" },
            { value: "dismiss", label: "dismiss" },
          ]}
        />
      </Tooltip>
    );
  }
  // The value field of an input-like action can be a secret (masked) or an env var.
  if (field === "value" && (action === "fill" || action === "select")) {
    return <ValueInput params={params} onChange={onChange} />;
  }

  const placeholder =
    field === "url"
      ? "https://…"
      : field === "attr"
        ? action === "expectAttribute"
          ? "attribute name"
          : "attr (blank=text)"
        : field === "regex"
        ? "regex (optional, e.g. /sha256:(\\S+)/)"
        : field === "saveAs"
          ? "save as…"
          : field === "path"
            ? "file path (blank → ~/.rubato/automation-data)"
            : field === "value" && action === "saveFile"
              ? "content — blank = all scraped as JSON (supports ${scraped.x})"
              : field === "value" && action === "setFiles"
                ? "file path(s) — newline/comma separated (supports ${run.dir})"
                : field === "value" && (action === "expectValue" || action === "expectAttribute")
                  ? "expected value (exact or /regex/)"
                  : field === "value" && action === "dialog"
                    ? "prompt text (when accepting)"
                    : "value (supports ${VAR})";
  return (
    <input
      value={(params[field] as string) ?? ""}
      onChange={(e) => onChange({ [field]: e.target.value } as Partial<StepParams>)}
      placeholder={placeholder}
      className={`${input} min-w-28 flex-1`}
    />
  );
}

/**
 * The value editor for fill/select steps with a mode toggle:
 *  - text   → plain input, supports ${VAR}/${scraped.x}
 *  - secret → masked (password) input; the literal is hidden from onlookers and
 *             redacted from run logs (still stored in the automation JSON)
 *  - env    → an env-var NAME the runner reads from process.env / ~/.rubato/.env
 *             (and exported specs read as process.env[NAME]); no secret is stored
 */
function ValueInput({ params, onChange }: { params: StepParams; onChange: (patch: Partial<StepParams>) => void }) {
  const mode = params.valueMode ?? "text";
  const [reveal, setReveal] = useState(false);
  const secret = mode === "secret";
  const placeholder = mode === "env" ? "ENV_VAR_NAME" : secret ? "secret value (hidden)" : "value (supports ${VAR})";
  return (
    <div className="flex min-w-28 flex-1 items-center gap-1">
      <Tooltip content="How this value is supplied">
        <Dropdown
          aria-label="Value source"
          value={mode}
          onChange={(v) => {
            const next = v as "text" | "secret" | "env";
            onChange({ valueMode: next === "text" ? undefined : next });
          }}
          options={[
            { value: "text", label: "text" },
            { value: "secret", label: "secret" },
            { value: "env", label: "variable" },
          ]}
        />
      </Tooltip>
      <div className="relative flex min-w-24 flex-1 items-center">
        <input
          // A secret stays masked until the eye is toggled, so a captured/edited
          // value can be checked without exposing it to onlookers by default.
          type={secret && !reveal ? "password" : "text"}
          autoComplete={secret ? "new-password" : "off"}
          value={params.value ?? ""}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder={placeholder}
          className={`${input} w-full ${secret ? "pr-8" : ""}`}
        />
        {secret && (
          <Tooltip content={reveal ? "Hide value" : "Reveal value"} className="absolute right-1.5">
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? "Hide value" : "Reveal value"}
              aria-pressed={reveal}
              className="text-gray-500 transition-colors hover:text-gray-900 dark:hover:text-gray-100"
            >
              {reveal ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function AddStep({ onAdd }: { onAdd: (a: ActionType) => void }) {
  return (
    <Dropdown
      aria-label="Add step"
      value={null}
      placeholder="+ Add step…"
      onChange={(v) => onAdd(v as ActionType)}
      options={ACTIONS.map((a) => ({ value: a.value, label: a.label }))}
      classNames={{
        root: "relative block w-full",
        trigger: () =>
          "flex w-full items-center justify-between gap-2 rounded border border-dashed border-gray-300 bg-transparent px-2 py-1.5 text-sm text-gray-500 dark:border-gray-700",
      }}
    />
  );
}

function IconBtn({ onClick, title, children }: { onClick: () => void; title?: string; children: ReactNode }) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      className="flex items-center rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
    >
      {children}
    </button>
  );
  return title ? <Tooltip content={title}>{btn}</Tooltip> : btn;
}
