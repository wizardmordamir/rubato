/**
 * Wire types for custom scripts and (next phase) pipelines. Kept in `shared/` so
 * both the server and the React UI import one definition. No runtime code, no
 * Node/Bun imports — safe behind the `@shared` alias.
 *
 * The two cross-stage channels these types describe:
 *   - a string `vars` bag that flows forward (a stage can declare outputs), and
 *   - a per-run working directory (`${run.dir}` / RUBATO_RUN_DIR) that files hand
 *     off through. A `StageOutcome` is what any stage (script, automation, …)
 *     returns to the runner.
 */

export type ScriptParamType = 'string' | 'number' | 'boolean';

/** A declared input for a script (drives the run form). Mirrors the AI ToolParam. */
export interface ScriptParam {
  name: string;
  type: ScriptParamType;
  description?: string;
  required?: boolean;
  /**
   * The value to start the run form at. Matters most for `boolean` params: the
   * UI renders them as a toggle, so the default decides whether the toggle reads
   * on or off before the user touches it (and the run honours that toggle state).
   */
  default?: string | number | boolean;
}

export type StageStatus = 'passed' | 'failed';

/** What a single stage/script run reports back to the runner. */
export interface StageOutcome {
  status: StageStatus;
  /** Merged into the shared vars bag for later stages. */
  vars?: Record<string, string>;
  /** Stage-specific payload (script stdout, automation steps, …) for display. */
  detail?: unknown;
}

/** A runnable script as surfaced to the UI/CLI — registered in-process or a file. */
export interface ScriptInfo {
  id: string;
  name: string;
  description?: string;
  params?: ScriptParam[];
  source: 'registered' | 'file';
  /** Absolute path to the `.ts` file backing a `source: 'file'` script (so the UI
   *  can offer "open in editor"). Undefined for in-process `registered` scripts. */
  file?: string;
}

/** Param values a user supplies for a run, keyed by ScriptParam.name. */
export type ScriptParamValues = Record<string, string | number | boolean>;

// ── Pipelines ────────────────────────────────────────────────────────────────

/**
 * The kind of work a stage does. Open union: an `excel` stage runs an Excel
 * Automation (the interactive builder's step pipeline) over a file in the run dir
 * — see ExcelStageIO. New stage types plug in by adding a kind + a StageExecutor.
 *
 * `transform` is the cross-step data-mapping kind: it reads structured data a
 * prior stage produced and lifts dot-path fields into named vars for later
 * stages — see TransformSpec.
 */
export type PipelineStageKind = 'automation' | 'script' | 'excel' | 'transform';

export interface PipelineStage {
  id: string;
  kind: PipelineStageKind;
  /** Id of the automation / script / excel-automation this stage runs (a transform stage names itself). */
  ref: string;
  label?: string;
  /** Per-stage var overrides; values may interpolate ${VAR} / ${run.dir}. */
  with?: Record<string, string>;
  /** Keep going if this stage fails (default: hard-stop the pipeline). */
  continueOnError?: boolean;
  /** Config for a `transform` stage (declarative JSON-path → vars mapping). */
  transform?: TransformSpec;
  /** I/O for an `excel` stage: which file to read + where to write the result. */
  excel?: ExcelStageIO;
}

/**
 * Where an `excel` stage reads its input and writes its output. The transform
 * itself is the referenced Excel Automation's steps (`stage.ref`); this is just
 * the run-dir file wiring — mirrors what the old standalone spec bundled.
 */
export interface ExcelStageIO {
  /** Input file in the run dir (or an absolute path); supports ${VAR}/${run.dir}. .csv or .xlsx. */
  input: string;
  /** For an .xlsx input: the worksheet to read (default: the first sheet). */
  sheet?: string;
  output: {
    /** Output filename (supports ${...}). */
    file: string;
    /** Where it lands: the run dir (default, for later stages) or the output dir. */
    to?: 'run' | 'output';
    /** Output format; inferred from the filename extension when omitted. */
    format?: 'csv' | 'xlsx';
  };
}

// ── Transform stage (cross-step data mapping) ────────────────────────────────

/**
 * Where a `transform` stage reads its source data from. At most one of these is
 * used; if none is set (or the whole `source` is omitted) the source is the live
 * vars bag itself, so a transform can also rename/remap existing vars.
 */
export interface TransformSource {
  /** Read + JSON-parse this file from the run dir. Path may interpolate ${VAR}/${run.dir}. */
  file?: string;
  /** JSON-parse the string value of this var (e.g. a prior step's JSON output). */
  var?: string;
  /** JSON-parse this inline literal (may interpolate ${VAR}/${run.dir} first). */
  inline?: string;
}

/** Lift one value out of the source into a named var for later stages. */
export interface TransformMapping {
  /** The var name to set in the bag. */
  as: string;
  /**
   * Dot/bracket path into the source — e.g. `summary.total`, `items.0.id`,
   * `rows[2].name`. Omit to take the whole source. A path that resolves to an
   * object/array is JSON-stringified; primitives are stringified as-is.
   */
  path?: string;
  /** Used when the path resolves to undefined (interpolated). If absent, the var is left unset. */
  default?: string;
}

/**
 * A declarative data-mapping stage. Previously, lifting fields out of a prior
 * step's output (a JSON file an AI/excel/script/playwright step wrote, or a JSON
 * var) required a hand-written glue script; a `transform` stage does it from
 * config: pick a source, then map JSON-paths → vars the next stages can use.
 */
export interface TransformSpec {
  source?: TransformSource;
  mappings: TransformMapping[];
}

export interface Pipeline {
  id: string;
  name: string;
  description?: string;
  stages: PipelineStage[];
  createdAt: number;
  updatedAt: number;
}

/** The result of running one stage (persisted + streamed for the UI). */
export interface PipelineStageResult {
  stageId: string;
  kind: PipelineStageKind;
  ref: string;
  label: string;
  status: 'passed' | 'failed' | 'skipped';
  /** Captured output (script stdout, automation summary). */
  output?: string;
  error?: string;
  /** Vars this stage declared (merged into the bag for later stages). */
  vars?: Record<string, string>;
  durationMs: number;
}

export interface PipelineRunRecord {
  id: number;
  pipeline: string;
  status: StageStatus;
  stages: PipelineStageResult[];
  /** The final vars bag after every stage. */
  vars: Record<string, string>;
  /** The per-run working directory (browsable in the Files tab). */
  dir: string;
  /** Absolute path to the run's diagnostic report (per-stage steps + any failures). */
  diagnosticPath?: string;
  startedAt: number;
  durationMs: number;
}

/** A variable a pipeline needs, flagged set-in-env or not (never the value). */
export interface PipelineVariable {
  name: string;
  present: boolean;
  sources: string[];
}
