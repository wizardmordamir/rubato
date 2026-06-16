import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useRegisterBreadcrumbLabel } from "../breadcrumbs";
import type { Condition, Step, StepParams, Target } from "@shared/automation";
import { manifestToMoments } from "@shared/timeline";
import { fetchAutomation, fetchCaptureManifest, generateStepsFromCapture } from "../api";
import { AutomationRunHistory } from "../builder/AutomationRunHistory";
import { actionSpec } from "../builder/model";
import { RunControls, RunPanel } from "../builder/RunControls";
import { type ResultMap, StepDiagnostics } from "../builder/StepList";
import { TimelinePlayer } from "../builder/TimelinePlayer";
import { useAutomationRunner } from "../builder/useAutomationRunner";
import { Alert, Badge, BTN_GHOST_CLASS, CARD_CLASS, OpenPathButton, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";

/** Inline monospace token for a selector / value / url. */
function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code
      title={title}
      className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200"
    >
      {children}
    </code>
  );
}

/** A configured step path is only safe to "open in editor" when it's absolute or
 *  ~-prefixed: a RELATIVE saveFile/screenshot path resolves against the step's
 *  automation-data / run dir, not the output dir the open endpoint assumes — so we
 *  hide the button for relative paths rather than open the wrong location. */
const isOpenablePath = (p?: string): p is string => !!p && (p.startsWith("~") || p.startsWith("/"));

/** Human-readable one-liner for a Target ("role button \"Save\" within …"). */
function describeTarget(t: Target): string {
  let s = t.kind === "role" && t.name ? `role ${t.value} “${t.name}”` : `${t.kind} ${t.value}`;
  if (t.exact) s += " (exact)";
  if (t.nth != null) s += ` #${t.nth}`;
  if (t.container) s += ` within ${describeTarget(t.container)}`;
  return s;
}

function TargetChip({ target }: { target?: Target }) {
  if (!target || !target.value) return <span className="text-gray-400">(no element)</span>;
  return <Chip title={describeTarget(target)}>{describeTarget(target)}</Chip>;
}

/** Render a step's `value`, masking secrets and naming env vars. */
function ValueChip({ params }: { params?: StepParams }) {
  const mode = params?.valueMode;
  if (mode === "secret") return <Chip title="a stored secret, hidden">••••••</Chip>;
  if (mode === "env") return <Chip title="resolved from the environment">${`{env.${params?.value ?? ""}}`}</Chip>;
  return <Chip>{params?.value ?? ""}</Chip>;
}

const WAIT_LABEL: Record<string, string> = {
  load: "the page to load",
  networkidle: "the network to be idle",
  visible: "the element to be visible",
  hidden: "the element to be hidden",
};

/** The descriptive line for one (leaf) step. */
function StepDetails({ step }: { step: Step }) {
  const p = step.params ?? {};
  const t = <TargetChip target={step.target} />;
  switch (step.action) {
    case "goto":
      return (
        <>
          Navigate to <Chip>{p.url || "(no url)"}</Chip>
        </>
      );
    case "waitFor":
      if (!p.waitKind || p.waitKind === "ms")
        return (
          <>
            Wait <Chip>{p.ms ?? 0}ms</Chip>
          </>
        );
      return <>Wait for {WAIT_LABEL[p.waitKind] ?? p.waitKind}</>;
    case "click":
      return <>Click {t}</>;
    case "fill":
      return (
        <>
          Fill {t} with <ValueChip params={p} />
        </>
      );
    case "select":
      return (
        <>
          Select <ValueChip params={p} /> in {t}
        </>
      );
    case "check":
      return <>Check {t}</>;
    case "uncheck":
      return <>Uncheck {t}</>;
    case "press":
      return (
        <>
          Press <Chip>{p.value || "(key)"}</Chip>
        </>
      );
    case "expectText":
      return (
        <>
          Expect {t} to contain <ValueChip params={p} />
        </>
      );
    case "expectUrl":
      return (
        <>
          Expect the URL to match <Chip>{p.value || ""}</Chip>
        </>
      );
    case "expectTitle":
      return (
        <>
          Expect the page title to be <Chip>{p.value || ""}</Chip>
        </>
      );
    case "expectVisible":
      return <>Expect {t} to be visible</>;
    case "expectCount":
      return (
        <>
          Expect <Chip>{p.count ?? 0}</Chip> of {t}
        </>
      );
    case "scrape":
      return (
        <>
          Scrape {p.attr ? <Chip>{p.attr}</Chip> : "text"} from {t}
          {p.saveAs ? (
            <>
              {" "}
              → save as <Chip>{p.saveAs}</Chip>
            </>
          ) : null}
        </>
      );
    case "screenshot":
      return (
        <>
          Take a screenshot
          {p.path ? (
            <>
              {" "}
              → <Chip>{p.path}</Chip>
              {isOpenablePath(p.path) && (
                <>
                  {" "}
                  <OpenPathButton path={p.path} />
                </>
              )}
            </>
          ) : null}
        </>
      );
    case "snapshot":
      return <>Snapshot the page (HTML + image){p.value ? <> · <Chip>{p.value}</Chip></> : null}</>;
    case "saveFile":
      return (
        <>
          Save to file <Chip>{p.path || "~/.rubato/automation-data/…"}</Chip>
          {isOpenablePath(p.path) ? (
            <>
              {" "}
              <OpenPathButton path={p.path} />
            </>
          ) : null}
          {p.value ? (
            <>
              {" "}
              · <ValueChip params={p} />
            </>
          ) : (
            <> · all scraped values as JSON</>
          )}
        </>
      );
    default:
      return <>{step.action}</>;
  }
}

function describeCondition(c: Condition): ReactNode {
  if (c.kind === "url-matches")
    return (
      <>
        the URL matches <Chip>{c.value || ""}</Chip>
      </>
    );
  return (
    <>
      <TargetChip target={c.target} /> is {c.kind === "selector-hidden" ? "hidden" : "visible"}
    </>
  );
}

// Live run status → a border tint and a status dot, so a replay paints each row
// (green as it passes, red where it broke) right here on the read-only view.
const STEP_RING: Record<string, string> = {
  running: "border-amber-300 dark:border-amber-800",
  passed: "border-emerald-300 dark:border-emerald-800",
  failed: "border-red-300 dark:border-red-800",
  skipped: "border-gray-300 dark:border-gray-700",
};
const STEP_DOT: Record<string, string> = {
  running: "bg-amber-400 animate-pulse",
  passed: "bg-emerald-500",
  failed: "bg-red-500",
  skipped: "bg-gray-400",
};

/**
 * A read-only step row (recurses for `if` then/else branches). `resultIndex` is
 * the interpreter's dotted key (0-based, e.g. "2" or "2.then.0") used to look up
 * this step's live result in `results` — distinct from the 1-based display label.
 */
function StepView({
  step,
  label,
  resultIndex,
  results,
}: {
  step: Step;
  label: string;
  resultIndex: string;
  results: ResultMap;
}) {
  const spec = actionSpec(step.action);
  const isIf = step.action === "if";
  const result = results[resultIndex];
  const ring = (result && STEP_RING[result.status]) || "border-gray-200 dark:border-gray-800";
  return (
    <li className={`rounded-lg border p-3 ${ring}`}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 px-1.5 font-mono text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {result && (
              <Tooltip content={result.status}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${STEP_DOT[result.status] ?? "bg-gray-300"}`} />
              </Tooltip>
            )}
            <Badge tone="accent">{spec.label}</Badge>
            {step.options?.optional && <Badge tone="neutral">optional</Badge>}
            {step.options?.timeout != null && <Badge tone="neutral">{step.options.timeout}ms timeout</Badge>}
          </div>
          <div className="mt-1.5 text-sm text-gray-700 dark:text-gray-200">
            {isIf ? <>If {step.condition ? describeCondition(step.condition) : "(no condition)"}</> : <StepDetails step={step} />}
          </div>
          {step.note && <div className="mt-1 text-xs text-gray-400">{step.note}</div>}
          {result && <StepDiagnostics result={result} />}

          {isIf && (
            <div className="mt-3 space-y-3">
              <Branch title="then" steps={step.thenSteps ?? []} parentLabel={label} parentResultIndex={resultIndex} branch="then" results={results} />
              {step.elseSteps && step.elseSteps.length > 0 && (
                <Branch title="else" steps={step.elseSteps} parentLabel={label} parentResultIndex={resultIndex} branch="else" results={results} />
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function Branch({
  title,
  steps,
  parentLabel,
  parentResultIndex,
  branch,
  results,
}: {
  title: string;
  steps: Step[];
  parentLabel: string;
  parentResultIndex: string;
  branch: "then" | "else";
  results: ResultMap;
}) {
  return (
    <div className="border-l-2 border-gray-200 pl-3 dark:border-gray-800">
      <div className="mb-1.5 text-xs font-semibold tracking-wide text-gray-400 uppercase">{title}</div>
      {steps.length === 0 ? (
        <div className="text-xs text-gray-400">(no steps)</div>
      ) : (
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <StepView
              key={s.id}
              step={s}
              label={`${parentLabel}.${i + 1}`}
              resultIndex={`${parentResultIndex}.${branch}.${i}`}
              results={results}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

export function ViewAutomationPage({ headerActions }: { headerActions?: ReactNode } = {}) {
  const { id = "" } = useParams();
  const runner = useAutomationRunner();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["automation", id],
    queryFn: () => fetchAutomation(id),
    enabled: !!id,
  });
  useRegisterBreadcrumbLabel(data?.name);

  // A captured flow can land with screenshots but no steps (the recorder's live
  // step stream is builder-memory only). The capture manifest is the durable
  // record, so when steps are empty we offer to regenerate them from it.
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const captureId = data?.capture?.id;
  const capture = useQuery({
    queryKey: ["capture", captureId],
    queryFn: () => fetchCaptureManifest(captureId as string),
    enabled: !!captureId,
  });
  const captureScreens = capture.data?.records.length ?? 0;
  const genSteps = useMutation({
    mutationFn: () => generateStepsFromCapture(id),
    onSuccess: (res) => {
      if (res.generated === 0) {
        notify("This capture has no replayable actions to turn into steps.", "info");
        return;
      }
      notify(`Generated ${res.generated} step${res.generated === 1 ? "" : "s"} from the capture.`, "success");
      qc.invalidateQueries({ queryKey: ["automation", id] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "could not generate steps", "error"),
  });

  // Re-deriving when the flow ALREADY has steps would clobber any hand-edits, so
  // it's gated behind a confirm (the empty-steps case below has nothing to lose
  // and stays one-click).
  const regenerateSteps = async () => {
    const ok = await confirm({
      prompt: "Regenerate steps from the capture?",
      flavorText:
        "This replaces the current steps with ones re-derived from the recorded capture. Any hand-edited steps will be overwritten.",
      confirmText: "Regenerate",
    });
    if (ok) genSteps.mutate();
  };

  return (
    <div className="mx-auto max-w-3xl">
      {isLoading && <p className="text-gray-400">Loading…</p>}
      {isError && (
        <Alert tone="error" size="sm">
          Couldn't load this automation.
        </Alert>
      )}

      {data && (
        <>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-2xl font-bold tracking-tight">{data.name}</h2>
              <div className="mt-1 text-sm text-gray-400">
                {data.steps.length} step{data.steps.length === 1 ? "" : "s"}
              </div>
              {data.description && <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{data.description}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <RunControls
                running={runner.running}
                onRun={(variables, urls, rows) => runner.run(data, variables, urls, rows)}
                headless={runner.headless}
                setHeadless={runner.setHeadless}
                keepOpen={runner.keepOpen}
                setKeepOpen={runner.setKeepOpen}
                speed={runner.speed}
                setSpeed={runner.setSpeed}
                automationId={data.id}
              />
              <Link to={`/automations/${data.id}/edit`} className={BTN_GHOST_CLASS}>
                Edit
              </Link>
              <Tooltip content="Export as a @playwright/test spec">
                <a
                  href={`/api/automations/${data.id}/export`}
                  download={`${data.id}.spec.ts`}
                  className={BTN_GHOST_CLASS}
                >
                  ↓ Export
                </a>
              </Tooltip>
              {/* Friend-app slot: extra actions an embedder injects beside the run/
                  edit/export controls. Undefined for rubato's own app → unchanged. */}
              {headerActions}
            </div>
          </div>

          {(runner.running || runner.lastRun || runner.heldOpen) && (
            <div className="mb-4">
              <RunPanel runner={runner} />
            </div>
          )}

          {data.startUrl && (
            <div className={`mb-4 flex flex-wrap items-center gap-2 ${CARD_CLASS} px-3 py-2`}>
              <span className="text-xs font-semibold tracking-wide text-gray-400 uppercase">Start URL</span>
              <a
                href={data.startUrl}
                target="_blank"
                rel="noreferrer"
                className="truncate font-mono text-sm text-accent hover:underline"
              >
                {data.startUrl}
              </a>
            </div>
          )}

          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-500">Steps</span>
            {data.steps.length > 0 && captureScreens > 0 && (
              <Tooltip content="Re-derive the steps from the recorded capture (overwrites the current steps)" className="ml-auto">
                <button
                  type="button"
                  onClick={regenerateSteps}
                  disabled={genSteps.isPending}
                  className="rounded-md border border-gray-300 px-2 py-0.5 text-xs text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  {genSteps.isPending ? "Regenerating…" : "↻ Regenerate from capture"}
                </button>
              </Tooltip>
            )}
          </div>
          {data.steps.length === 0 ? (
            captureScreens > 0 ? (
              <div className={`flex flex-wrap items-center gap-3 ${CARD_CLASS} px-4 py-3`}>
                <div className="min-w-0 text-sm text-gray-600 dark:text-gray-300">
                  This flow has a capture ({captureScreens} screen{captureScreens === 1 ? "" : "s"}) but no steps yet —
                  generate them from the recorded actions.
                </div>
                <button
                  type="button"
                  onClick={() => genSteps.mutate()}
                  disabled={genSteps.isPending}
                  className="ml-auto rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  {genSteps.isPending ? "Generating…" : "Generate steps from capture"}
                </button>
              </div>
            ) : (
              <p className="text-gray-400">This automation has no steps yet.</p>
            )
          ) : (
            <ol className="space-y-2">
              {data.steps.map((s, i) => (
                <StepView key={s.id} step={s} label={String(i + 1)} resultIndex={String(i)} results={runner.results} />
              ))}
            </ol>
          )}

          {data.capture?.id && <CaptureTimeline id={data.capture.id} />}

          <div className="mt-8">
            <AutomationRunHistory name={data.name} />
          </div>
        </>
      )}
    </div>
  );
}

/** Read-only captured HTML+screenshot timeline for a saved flow that has one. */
function CaptureTimeline({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ["capture", id], queryFn: () => fetchCaptureManifest(id) });
  if (!data || data.records.length === 0) return null;
  return (
    <div className="mt-8">
      <div className="mb-2 text-sm font-semibold text-gray-500">
        Captured timeline · {data.records.length} screen{data.records.length === 1 ? "" : "s"}
      </div>
      <div className={`h-[28rem] overflow-hidden rounded-xl border ${CARD_CLASS}`}>
        <TimelinePlayer moments={manifestToMoments(data)} />
      </div>
    </div>
  );
}
