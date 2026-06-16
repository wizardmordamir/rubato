import { useQuery } from "@tanstack/react-query";
import type { LayoutField } from "cwip/layout";
import type { WidgetRegistry } from "cwip/react";
import {
  BOARD_STATUS_LABELS,
  BOARD_STATUSES,
  fetchApps,
  fetchAutomationRuns,
  fetchBoardTasks,
  fetchDashboard,
  fetchPipelineRuns,
  fetchPlans,
  fetchRequests,
  fetchRuns,
  fetchSavedCommands,
  fetchSavedDbQueries,
  fetchSystemHealth,
  fetchVulnerabilities,
} from "../../api";

// Rubato's widget palette for custom Pages. The layout/grid/editor are the shared
// cwip engine; these are rubato's own widgets. All bind `static` (decoration) or
// self-fetch their data via TanStack Query — there are no per-record "columns" on a
// dashboard surface, so widgets read app data directly inside their render.

// ── shared bits ───────────────────────────────────────────────────────────────

const Muted = ({ children }: { children: React.ReactNode }) => (
  <span className="text-sm text-gray-400">{children}</span>
);

// A bold number/value with a tiny uppercase caption — the dashboard's unit of stat.
const Stat = ({ value, label }: { value: React.ReactNode; label: string }) => (
  <div className="min-w-0">
    <div className="text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">{value}</div>
    <div className="truncate text-xs uppercase tracking-wide text-gray-400">{label}</div>
  </div>
);

const StatusBadge = ({ ok, label }: { ok: boolean; label: string }) => (
  <span
    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
      ok
        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
        : "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
    }`}
  >
    {label}
  </span>
);

type RecentRow = { key: string; left: React.ReactNode; right?: React.ReactNode };
const RecentList = ({ rows, empty = "Nothing yet" }: { rows: RecentRow[]; empty?: string }) =>
  rows.length === 0 ? (
    <Muted>{empty}</Muted>
  ) : (
    <ul className="flex min-w-0 flex-1 flex-col gap-1">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center justify-between gap-2 text-sm">
          <span className="min-w-0 truncate text-gray-700 dark:text-gray-300">{r.left}</span>
          {r.right}
        </li>
      ))}
    </ul>
  );

// Compact relative time ("2m ago"). Uses Date.now at render — fine for a dashboard.
const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const byNewest = <T extends { startedAt?: number; createdAt?: number }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (b.startedAt ?? b.createdAt ?? 0) - (a.startedAt ?? a.createdAt ?? 0));

// ── data widgets (self-fetching) ──────────────────────────────────────────────

const BoardSummary = () => {
  const { data: tasks = [], isLoading } = useQuery({ queryKey: ["board"], queryFn: fetchBoardTasks });
  if (isLoading) return <Muted>Loading board…</Muted>;
  return (
    <div className="flex flex-wrap gap-4">
      {BOARD_STATUSES.map((s) => (
        <Stat key={s} value={tasks.filter((t) => t.status === s).length} label={BOARD_STATUS_LABELS[s]} />
      ))}
    </div>
  );
};

const AppsSummary = () => {
  const { data: apps = [], isLoading } = useQuery({ queryKey: ["apps"], queryFn: fetchApps });
  if (isLoading) return <Muted>Loading apps…</Muted>;
  return <Stat value={apps.length} label="registered apps" />;
};

const GitOverview = () => {
  const { data, isLoading } = useQuery({ queryKey: ["dashboard"], queryFn: () => fetchDashboard(false) });
  if (isLoading || !data) return <Muted>Loading git status…</Muted>;
  const s = data.summary;
  return (
    <div className="flex flex-wrap gap-4">
      <Stat value={s.repos} label="repos" />
      <Stat value={s.clean} label="clean" />
      <Stat value={s.dirty} label="dirty" />
      <Stat value={s.ahead} label="ahead" />
      <Stat value={s.behind} label="behind" />
    </div>
  );
};

const VulnerabilitySummary = () => {
  const { data, isLoading } = useQuery({ queryKey: ["vulnerabilities"], queryFn: fetchVulnerabilities });
  if (isLoading || !data) return <Muted>Loading scans…</Muted>;
  const t = data.stats.totals;
  return (
    <div className="flex flex-wrap gap-4">
      <Stat value={t.critical} label="critical" />
      <Stat value={t.high} label="high" />
      <Stat value={t.medium} label="medium" />
      <Stat value={t.low} label="low" />
    </div>
  );
};

const PipelineRuns = () => {
  const { data: runs = [], isLoading } = useQuery({ queryKey: ["pipelineRuns"], queryFn: () => fetchPipelineRuns() });
  if (isLoading) return <Muted>Loading runs…</Muted>;
  const passed = runs.filter((r) => r.status === "passed").length;
  const recent = byNewest(runs).slice(0, 3);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4">
        <Stat value={passed} label="passed" />
        <Stat value={runs.length - passed} label="failed" />
      </div>
      <RecentList
        empty="No runs yet"
        rows={recent.map((r) => ({
          key: String(r.id),
          left: r.pipeline,
          right: <StatusBadge ok={r.status === "passed"} label={r.status} />,
        }))}
      />
    </div>
  );
};

const RecentRuns = () => {
  const { data: runs = [], isLoading } = useQuery({ queryKey: ["runs"], queryFn: fetchRuns });
  if (isLoading) return <Muted>Loading runs…</Muted>;
  const recent = byNewest(runs).slice(0, 4);
  return (
    <RecentList
      empty="No runs yet"
      rows={recent.map((r) => ({
        key: `${r.command}-${r.startedAt}`,
        left: r.command,
        right: <StatusBadge ok={r.exitCode === 0} label={r.exitCode === 0 ? "ok" : `exit ${r.exitCode}`} />,
      }))}
    />
  );
};

const SystemHealth = () => {
  const { data, isLoading } = useQuery({ queryKey: ["systemHealth"], queryFn: fetchSystemHealth });
  if (isLoading || !data) return <Muted>Loading health…</Muted>;
  const s = data.summary;
  return (
    <div className="flex flex-wrap gap-4">
      <Stat value={s.error} label="errors" />
      <Stat value={s.warn} label="warnings" />
      <Stat value={s.info} label="info" />
      <Stat value={s.ok} label="ok" />
    </div>
  );
};

const PlansSummary = () => {
  const { data: plans = [], isLoading } = useQuery({ queryKey: ["plans"], queryFn: fetchPlans });
  if (isLoading) return <Muted>Loading plans…</Muted>;
  const recent = byNewest(plans).slice(0, 3);
  return (
    <div className="flex items-start gap-4">
      <Stat value={plans.length} label="plans" />
      <RecentList empty="No plans yet" rows={recent.map((p) => ({ key: p.id, left: p.title }))} />
    </div>
  );
};

const AutomationRuns = () => {
  const { data: runs = [], isLoading } = useQuery({
    queryKey: ["automationRuns"],
    queryFn: () => fetchAutomationRuns(),
  });
  if (isLoading) return <Muted>Loading runs…</Muted>;
  const passed = runs.filter((r) => r.status === "passed").length;
  const last = byNewest(runs)[0];
  return (
    <div className="flex flex-wrap gap-4">
      <Stat value={passed} label="passed" />
      <Stat value={runs.length - passed} label="failed" />
      {last && <Stat value={ago(last.startedAt)} label="last run" />}
    </div>
  );
};

const SavedLibrary = () => {
  const { data, isLoading } = useQuery({
    queryKey: ["savedLibrary"],
    queryFn: () => Promise.all([fetchSavedDbQueries(), fetchSavedCommands(), fetchRequests()]),
  });
  if (isLoading || !data) return <Muted>Loading library…</Muted>;
  const [queries, commands, requests] = data;
  return (
    <div className="flex flex-wrap gap-4">
      <Stat value={queries.length} label="saved queries" />
      <Stat value={commands.length} label="saved commands" />
      <Stat value={requests.length} label="saved requests" />
    </div>
  );
};

// ── the registry ──────────────────────────────────────────────────────────────

export const RUBATO_WIDGETS: WidgetRegistry<LayoutField> = {
  // The fallback widget (cwip coerces unknown node types to `keyValue`).
  keyValue: {
    type: "keyValue",
    title: "Text",
    description: "A plain text block.",
    category: "Field",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: (ctx) => (
      <div className="text-sm text-gray-700 dark:text-gray-300">{ctx.node.content || <Muted>—</Muted>}</div>
    ),
  },
  heading: {
    type: "heading",
    title: "Heading",
    description: "A bold section heading.",
    category: "Decoration",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: (ctx) => (
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {ctx.node.content || "Heading"}
      </h3>
    ),
  },
  text: {
    type: "text",
    title: "Text",
    description: "A paragraph of helper text.",
    category: "Decoration",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: (ctx) => (
      <p className="whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-400">
        {ctx.node.content || "Helper text"}
      </p>
    ),
  },
  divider: {
    type: "divider",
    title: "Divider",
    description: "A horizontal rule.",
    category: "Decoration",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: () => <hr className="border-gray-200 dark:border-gray-700" />,
  },
  section: {
    type: "section",
    title: "Section",
    description: "A titled group of widgets.",
    category: "Layout",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    container: true,
    render: (ctx) => (
      <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        {ctx.node.title && (
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
            {ctx.node.title}
          </div>
        )}
        {ctx.children}
      </div>
    ),
  },
  boardSummary: {
    type: "boardSummary",
    title: "Board summary",
    description: "Task counts per status from the Board.",
    category: "Aggregate",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: () => <BoardSummary />,
  },
  appsSummary: {
    type: "appsSummary",
    title: "Apps count",
    description: "How many code repos are registered.",
    category: "Aggregate",
    defaultWidth: "third",
    acceptsBindingKinds: ["static"],
    render: () => <AppsSummary />,
  },
  gitOverview: {
    type: "gitOverview",
    title: "Git overview",
    description: "Cross-app git status: repos, clean, dirty, ahead, behind.",
    category: "Aggregate",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: () => <GitOverview />,
  },
  vulnerabilitySummary: {
    type: "vulnerabilitySummary",
    title: "Vulnerabilities",
    description: "Severity totals (critical/high/medium/low) across all apps.",
    category: "Aggregate",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: () => <VulnerabilitySummary />,
  },
  pipelineRuns: {
    type: "pipelineRuns",
    title: "Pipeline runs",
    description: "Pass/fail counts and the most recent pipeline runs.",
    category: "Aggregate",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: () => <PipelineRuns />,
  },
  recentRuns: {
    type: "recentRuns",
    title: "Recent runs",
    description: "The latest command runs with their exit status.",
    category: "Aggregate",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: () => <RecentRuns />,
  },
  systemHealth: {
    type: "systemHealth",
    title: "System health",
    description: "System health checks by severity (errors/warnings/info/ok).",
    category: "Aggregate",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: () => <SystemHealth />,
  },
  plansSummary: {
    type: "plansSummary",
    title: "Plans",
    description: "Remediation plan count and the most recent titles.",
    category: "Aggregate",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: () => <PlansSummary />,
  },
  automationRuns: {
    type: "automationRuns",
    title: "Automation runs",
    description: "Browser-automation pass/fail counts and last run.",
    category: "Aggregate",
    defaultWidth: "half",
    acceptsBindingKinds: ["static"],
    render: () => <AutomationRuns />,
  },
  savedLibrary: {
    type: "savedLibrary",
    title: "Saved library",
    description: "Counts of saved queries, commands, and HTTP requests.",
    category: "Aggregate",
    defaultWidth: "full",
    acceptsBindingKinds: ["static"],
    render: () => <SavedLibrary />,
  },
};

// Palette groups (what the editor's "Add widget" menu offers), in display order.
export const PALETTE: { type: string; title: string; defaultContent?: string }[] = [
  // structural
  { type: "heading", title: "Heading", defaultContent: "Section heading" },
  { type: "text", title: "Text", defaultContent: "Helper text" },
  { type: "divider", title: "Divider" },
  { type: "section", title: "Section" },
  // data
  { type: "gitOverview", title: "Git overview" },
  { type: "boardSummary", title: "Board summary" },
  { type: "appsSummary", title: "Apps count" },
  { type: "vulnerabilitySummary", title: "Vulnerabilities" },
  { type: "pipelineRuns", title: "Pipeline runs" },
  { type: "recentRuns", title: "Recent runs" },
  { type: "automationRuns", title: "Automation runs" },
  { type: "systemHealth", title: "System health" },
  { type: "plansSummary", title: "Plans" },
  { type: "savedLibrary", title: "Saved library" },
];
