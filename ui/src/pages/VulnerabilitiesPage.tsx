import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DisclosureButton } from "cursedbelt/react";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  addVulnerability,
  type DeployApp,
  type VulnerabilitiesResponse,
  type VulnerabilityRecord,
  type VulnSeverity,
  VULN_SEVERITIES,
  clearVulnerabilities,
  deleteVulnerability,
  fetchDeployApps,
  fetchVulnerabilities,
  generateVulnerabilityPlan,
  importVulnerabilityPdf,
  linkVulnerabilityApp,
  vulnerabilityReportUrl,
} from "../api";
import { Badge, BTN_GHOST_CLASS, BTN_PRIMARY_CLASS, CARD_CLASS, FIELD_CLASS, PageHeading, SearchInput, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { useToast } from "../toast";

const SEV_TONE: Record<VulnSeverity, string> = {
  critical: "text-rose-600 dark:text-rose-400",
  high: "text-orange-600 dark:text-orange-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "text-sky-600 dark:text-sky-400",
  informational: "text-gray-500 dark:text-gray-400",
};
const SEV_DOT: Record<VulnSeverity, string> = {
  critical: "bg-rose-500",
  high: "bg-orange-500",
  medium: "bg-amber-500",
  low: "bg-sky-500",
  informational: "bg-gray-400",
};

const recordKey = (r: { app: string; scanType: string }) => `${r.app}:${r.scanType}`;

/** Best deploy-app guess for a scan's app label: exact name, else a substring overlap. */
function bestDeployMatch(scanApp: string, apps: DeployApp[]): string {
  const q = scanApp.trim().toLowerCase();
  if (!q) return "";
  const exact = apps.find((a) => a.name.toLowerCase() === q);
  if (exact) return exact.name;
  const partial = apps.find((a) => {
    const n = a.name.toLowerCase();
    return n.includes(q) || q.includes(n);
  });
  return partial?.name ?? "";
}

/**
 * Vulnerabilities view — per-app AppScan/ASoC scan stats stored in the
 * `app_vulnerabilities` table (imported from a report PDF here, written by the
 * `appscan-pdf` pipeline script, or added by hand). Answers: totals per severity,
 * which apps carry a given severity, which apps are vuln-free, and — the headline —
 * which apps share the SAME issue type so they can be fixed together.
 */
export function VulnerabilitiesPage() {
  const qc = useQueryClient();
  const { notify } = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data, isLoading, isFetching, refetch } = useQuery({ queryKey: ["vulnerabilities"], queryFn: fetchVulnerabilities });
  const { data: deployApps = [] } = useQuery({ queryKey: ["deploy-apps"], queryFn: fetchDeployApps });

  const [search, setSearch] = useState("");
  const [sev, setSev] = useState<VulnSeverity | "all">("all");
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // After an import, prompt to associate the new scan with the deployed app it came from.
  const [linkPrompt, setLinkPrompt] = useState<{ app: string; scanType: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const records = data?.records ?? [];
  const stats = data?.stats;

  const onData = (d: VulnerabilitiesResponse) => qc.setQueryData(["vulnerabilities"], d);
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const del = useMutation({
    mutationFn: (r: VulnerabilityRecord) => deleteVulnerability(r.app, r.scanType),
    onSuccess: onData,
    onError: (e) => notify(e instanceof Error ? e.message : "delete failed", "error"),
  });
  const clearAll = useMutation({
    mutationFn: clearVulnerabilities,
    onSuccess: onData,
    onError: (e) => notify(e instanceof Error ? e.message : "clear failed", "error"),
  });
  const importPdf = useMutation({
    mutationFn: (file: File) => importVulnerabilityPdf(file),
    onSuccess: (d) => {
      onData(d);
      const i = d.imported;
      if (i) {
        notify(
          i.isAppScan
            ? `Imported ${i.app}${i.scanType ? ` (${i.scanType})` : ""}`
            : `Imported ${i.app} — didn't look like an AppScan report (parsed best-effort)`,
          i.isAppScan ? "success" : "info",
        );
        // Offer to associate the freshly-imported scan with its deployed app.
        setLinkPrompt({ app: i.app, scanType: i.scanType });
      }
    },
    onError: (e) => notify(e instanceof Error ? e.message : "import failed", "error"),
  });
  const link = useMutation({
    mutationFn: ({ app, scanType, linkedApp }: { app: string; scanType: string; linkedApp: string | null }) =>
      linkVulnerabilityApp(app, scanType, linkedApp),
    onSuccess: (d, vars) => {
      onData(d);
      notify(vars.linkedApp ? `Linked to ${vars.linkedApp}` : "Cleared app association", "success");
      setLinkPrompt(null);
    },
    onError: (e) => notify(e instanceof Error ? e.message : "linking failed", "error"),
  });
  const genPlan = useMutation({
    mutationFn: (r: VulnerabilityRecord) => generateVulnerabilityPlan(r.app, r.scanType),
    onSuccess: (res) => {
      notify(`Generated "${res.title}" — opening Plans`, "success");
      navigate("/plans");
    },
    onError: (e) => notify(e instanceof Error ? e.message : "plan generation failed", "error"),
  });

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter(
      (r) => (!q || r.app.toLowerCase().includes(q)) && (sev === "all" || r[sev] > 0),
    );
  }, [records, search, sev]);

  return (
    <div className="flex flex-col gap-5">
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) importPdf.mutate(file);
          e.target.value = ""; // allow re-importing the same file
        }}
      />
      <PageHeading
        title="Vulnerabilities"
        count={records.length}
        actions={
          <>
            <Tooltip multiline content="Upload an HCL AppScan / ASoC report PDF (SAST or DAST). The server extracts the severity counts + per-issue-type breakdown, stores them, and keeps the PDF so you can open it here.">
              <button type="button" className={BTN_PRIMARY_CLASS} disabled={importPdf.isPending} onClick={() => fileInput.current?.click()}>
                {importPdf.isPending ? "Importing…" : "⤓ Import scan PDF"}
              </button>
            </Tooltip>
            <Tooltip multiline content="Add a vulnerability record by hand — an app's per-severity scan counts for a scan type. Normally these come from an imported PDF or the appscan-pdf pipeline script.">
              <button type="button" className={BTN_GHOST_CLASS} onClick={() => setAdding((a) => !a)}>
                {adding ? "Close" : "+ Add"}
              </button>
            </Tooltip>
            <button type="button" className={BTN_GHOST_CLASS} disabled={isFetching} onClick={() => refetch()}>
              <span className={`inline-block ${isFetching ? "animate-spin" : ""}`}>↻</span>
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
            {records.length > 0 && (
              <button
                type="button"
                className={BTN_GHOST_CLASS}
                onClick={async () => {
                  if (
                    await confirm({
                      prompt: "Clear all stored vulnerability records (and their report PDFs)?",
                      flavorText: "This cannot be undone.",
                      confirmText: "Clear all",
                    })
                  )
                    clearAll.mutate();
                }}
              >
                Clear all
              </button>
            )}
          </>
        }
      />

      <p className="-mt-2 text-xs text-gray-500">
        Per-app AppScan/ASoC scan stats. <span className="font-medium">Import a report PDF</span> above, populate via the{" "}
        <Link to="/scripts" className="font-mono text-accent hover:underline">
          appscan-pdf
        </Link>{" "}
        pipeline script, or add a record by hand. Findings are stored per-severity and per issue type so you can compare apps and generate remediation plans.
      </p>

      {linkPrompt && (
        <LinkPrompt
          prompt={linkPrompt}
          deployApps={deployApps}
          current={records.find((r) => r.app === linkPrompt.app && r.scanType === linkPrompt.scanType)?.linkedApp ?? ""}
          pending={link.isPending}
          onLink={(linkedApp) => link.mutate({ ...linkPrompt, linkedApp })}
          onDismiss={() => setLinkPrompt(null)}
        />
      )}

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Stat label="Apps scanned" value={stats.apps} />
          {VULN_SEVERITIES.map((s) => (
            <Stat key={s} label={s[0].toUpperCase() + s.slice(1)} value={stats.totals[s]} tone={s} />
          ))}
          <Stat label="Vuln-free apps" value={stats.vulnFree.length} />
        </div>
      )}

      {adding && <AddForm onData={onData} onClose={() => setAdding(false)} />}

      {stats && stats.vulnFree.length > 0 && (
        <div className={`${CARD_CLASS} flex flex-wrap items-center gap-2 p-3`}>
          <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">Vulnerability-free</span>
          {stats.vulnFree.map((app) => (
            <Badge key={app} tone="success">
              {app}
            </Badge>
          ))}
        </div>
      )}

      {stats && stats.sharedIssues.length > 0 && <SharedIssues stats={stats} />}

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="filter apps…" />
        <div className="flex flex-wrap gap-1.5">
          {(["all", ...VULN_SEVERITIES] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSev(s)}
              className={`rounded-full border px-3 py-1 text-xs capitalize transition pointer-coarse:min-h-9 ${
                sev === s
                  ? "border-accent bg-accent-soft font-medium text-accent"
                  : "border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              }`}
            >
              {s === "all" ? "All" : `has ${s}`}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <p className="text-gray-400">loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-gray-500">
          {records.length === 0 ? "No scans recorded yet — import a report PDF to get started." : "No apps match the current filter."}
        </p>
      ) : (
        <div className={`${CARD_CLASS} overflow-x-auto p-0`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 dark:border-gray-800">
                <th className="px-3 py-2">App</th>
                <th className="px-3 py-2">Scan</th>
                {VULN_SEVERITIES.map((s) => (
                  <th key={s} className="px-3 py-2 text-right capitalize">
                    {s === "informational" ? "info" : s}
                  </th>
                ))}
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Scanned</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const key = recordKey(r);
                const open = expanded.has(key);
                return (
                  <RecordRow
                    key={key}
                    r={r}
                    open={open}
                    deployApps={deployApps}
                    onToggle={() => toggle(key)}
                    onDelete={() => del.mutate(r)}
                    onGenPlan={() => genPlan.mutate(r)}
                    onLink={(linkedApp) => link.mutate({ app: r.app, scanType: r.scanType, linkedApp })}
                    linkPending={link.isPending && link.variables?.app === r.app && link.variables?.scanType === r.scanType}
                    planPending={genPlan.isPending && genPlan.variables?.app === r.app && genPlan.variables?.scanType === r.scanType}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: VulnSeverity }) {
  return (
    <div className={`${CARD_CLASS} flex flex-col gap-1 p-3`}>
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${tone ? SEV_TONE[tone] : ""}`}>{value}</span>
    </div>
  );
}

/** "Find which apps have the same problems" — issue types ranked by how many apps share them. */
function SharedIssues({ stats }: { stats: NonNullable<VulnerabilitiesResponse["stats"]> }) {
  const [sharedOnly, setSharedOnly] = useState(true);
  const multi = stats.sharedIssues.filter((i) => i.appCount > 1);
  const rows = sharedOnly && multi.length > 0 ? multi : stats.sharedIssues;
  return (
    <div className={`${CARD_CLASS} flex flex-col gap-3 p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Shared issues across apps</h2>
          <p className="text-xs text-gray-500">
            The same issue type in multiple apps — fix them together. {multi.length} type{multi.length === 1 ? "" : "s"} affect 2+ apps.
          </p>
        </div>
        {multi.length > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={sharedOnly} onChange={(e) => setSharedOnly(e.target.checked)} />
            only issues in 2+ apps
          </label>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 dark:border-gray-800">
              <th className="px-2 py-2">Issue type</th>
              <th className="px-2 py-2 text-right">Apps</th>
              <th className="px-2 py-2 text-right">Findings</th>
              <th className="px-2 py-2">Affected apps</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((issue) => (
              <tr key={issue.type} className="border-b border-gray-100 last:border-0 align-top dark:border-gray-800/60">
                <td className="px-2 py-2 font-medium">
                  <span className="flex items-center gap-2">
                    {issue.severity && (
                      <Tooltip content={issue.severity}><span className={`inline-block h-2 w-2 shrink-0 rounded-full ${SEV_DOT[issue.severity]}`} /></Tooltip>
                    )}
                    {issue.type}
                  </span>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  <span className={issue.appCount > 1 ? "font-semibold text-accent" : "text-gray-500"}>{issue.appCount}</span>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{issue.totalCount}</td>
                <td className="px-2 py-2">
                  <span className="flex flex-wrap gap-1">
                    {issue.apps.map((a) => (
                      <Badge key={`${a.app}:${a.scanType}`} tone={issue.appCount > 1 ? "accent" : "neutral"}>
                        {a.app}
                        {a.scanType ? ` · ${a.scanType}` : ""} ({a.count})
                      </Badge>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecordRow({
  r,
  open,
  deployApps,
  onToggle,
  onDelete,
  onGenPlan,
  onLink,
  linkPending,
  planPending,
}: {
  r: VulnerabilityRecord;
  open: boolean;
  deployApps: DeployApp[];
  onToggle: () => void;
  onDelete: () => void;
  onGenPlan: () => void;
  onLink: (linkedApp: string | null) => void;
  linkPending: boolean;
  planPending: boolean;
}) {
  const confirm = useConfirm();
  const [viewPdf, setViewPdf] = useState(false);
  // The row expands when there's anything to show: issue types, a stored report,
  // or an app association to view/manage (any deploy app exists, or one is set).
  const canLink = deployApps.length > 0 || !!r.linkedApp;
  const hasDetail = (r.issueTypes?.length ?? 0) > 0 || !!r.reportName || canLink;
  return (
    <>
      <tr className="border-b border-gray-100 last:border-0 dark:border-gray-800/60">
        <td className="px-3 py-2 font-medium">
          <div className="flex flex-wrap items-center gap-2">
            {hasDetail ? (
              <DisclosureButton open={open} onToggle={onToggle} className="gap-1 hover:text-accent">
                {r.app}
              </DisclosureButton>
            ) : (
              <span className="pl-4">{r.app}</span>
            )}
            {r.linkedApp && (
              <Tooltip content={`Deployed app: ${r.linkedApp}`}>
                <Badge tone="accent">🔗 {r.linkedApp}</Badge>
              </Tooltip>
            )}
          </div>
        </td>
        <td className="px-3 py-2">{r.scanType ? <Badge tone="neutral">{r.scanType}</Badge> : <span className="text-gray-400">—</span>}</td>
        {VULN_SEVERITIES.map((s) => (
          <td key={s} className={`px-3 py-2 text-right tabular-nums ${r[s] > 0 ? SEV_TONE[s] : "text-gray-400"}`}>
            {r[s]}
          </td>
        ))}
        <td className="px-3 py-2 text-right font-semibold tabular-nums">{r.total}</td>
        <td className="px-3 py-2 text-xs text-gray-400">{new Date(r.scannedAt).toLocaleString()}</td>
        <td className="px-3 py-2 text-right">
          <button
            type="button"
            className="text-xs text-gray-400 hover:text-rose-500"
            onClick={async () => {
              if (await confirm({ prompt: "Delete this record?", confirmText: "Delete" })) onDelete();
            }}
            aria-label="Delete record"
          >
            ✕
          </button>
        </td>
      </tr>
      {open && (
        <tr className="bg-gray-50/60 dark:bg-gray-900/30">
          <td colSpan={VULN_SEVERITIES.length + 4} className="px-4 py-3">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {r.reportName && (
                  <>
                    <button type="button" className={BTN_GHOST_CLASS} onClick={() => setViewPdf((v) => !v)}>
                      {viewPdf ? "Hide PDF" : "📄 View report"}
                    </button>
                    <a className={BTN_GHOST_CLASS} href={vulnerabilityReportUrl(r.app, r.scanType)} target="_blank" rel="noreferrer">
                      ↗ Open in new tab
                    </a>
                  </>
                )}
                <Tooltip multiline content="Send this scan's severity counts + issue-type breakdown to the configured LLM and store a Markdown remediation plan on the Plans page. Requires an LLM endpoint in ~/.rubato config/.env.">
                  <button type="button" className={BTN_PRIMARY_CLASS} disabled={planPending} onClick={onGenPlan}>
                    {planPending ? "Generating…" : "✦ Generate remediation plan"}
                  </button>
                </Tooltip>
              </div>

              {canLink && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">Deployed app</span>
                  <DeployAppPicker
                    deployApps={deployApps}
                    value={r.linkedApp ?? ""}
                    pending={linkPending}
                    submitLabel={r.linkedApp ? "Update" : "Link"}
                    onSubmit={onLink}
                  />
                  <span className="text-[11px] text-gray-400">
                    The Jenkins/Harness app this scan deploys from — where the scan runs.
                  </span>
                </div>
              )}

              {viewPdf && r.reportName && (
                <iframe
                  title={`${r.app} report`}
                  src={vulnerabilityReportUrl(r.app, r.scanType)}
                  className="h-[70vh] w-full rounded-lg border border-gray-200 bg-white dark:border-gray-700"
                />
              )}

              {(r.issueTypes?.length ?? 0) > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-gray-500">Issue types ({r.issueTypes?.length})</div>
                  <div className="flex flex-wrap gap-1.5">
                    {r.issueTypes?.map((it) => (
                      <span
                        key={it.name}
                        className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-2.5 py-1 text-xs dark:border-gray-700"
                      >
                        {it.severity && <Tooltip content={it.severity}><span className={`inline-block h-2 w-2 rounded-full ${SEV_DOT[it.severity]}`} /></Tooltip>}
                        {it.name}
                        <span className="font-semibold tabular-nums text-gray-500">{it.count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Post-import banner: offer to associate the freshly-imported scan with the
 * deployed app (Jenkins/Harness) it came from — that's where the scan runs.
 */
function LinkPrompt({
  prompt,
  deployApps,
  current,
  pending,
  onLink,
  onDismiss,
}: {
  prompt: { app: string; scanType: string };
  deployApps: DeployApp[];
  current: string;
  pending: boolean;
  onLink: (linkedApp: string | null) => void;
  onDismiss: () => void;
}) {
  const label = `${prompt.app}${prompt.scanType ? ` (${prompt.scanType})` : ""}`;
  return (
    <div className={`${CARD_CLASS} flex flex-col gap-2 border-accent/50 p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Associate “{label}” with a deployed app</h2>
          <p className="text-xs text-gray-500">
            Jenkins/Harness apps are where code deploys — and where scans run. Link this scan to the app it came from.
          </p>
        </div>
        <button type="button" className="shrink-0 text-xs text-gray-400 hover:text-gray-600" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {deployApps.length === 0 ? (
        <p className="text-xs text-gray-500">
          No deployed apps (Jenkins/Harness) in your registry yet. Add a <span className="font-mono">jenkins</span> or{" "}
          <span className="font-mono">harness</span> tag/API to an app on the{" "}
          <Link to="/apps" className="text-accent hover:underline">
            Apps
          </Link>{" "}
          page, then link this scan from its row.
        </p>
      ) : (
        <DeployAppPicker
          deployApps={deployApps}
          value={current}
          autoSelect={current || bestDeployMatch(prompt.app, deployApps)}
          pending={pending}
          submitLabel="Link"
          onSubmit={onLink}
        />
      )}
    </div>
  );
}

/** A <select> of deploy apps + a submit button — used by the import prompt and each row. */
function DeployAppPicker({
  deployApps,
  value,
  onSubmit,
  pending,
  submitLabel = "Link",
  autoSelect,
}: {
  deployApps: DeployApp[];
  /** The currently-stored association ("" = none). */
  value: string;
  onSubmit: (linkedApp: string | null) => void;
  pending: boolean;
  submitLabel?: string;
  /** Initial selection override (e.g. a best-match guess after import). */
  autoSelect?: string;
}) {
  const [sel, setSel] = useState(autoSelect ?? value);
  // Keep the stored value selectable even if the app no longer reports a pipeline.
  const options =
    value && !deployApps.some((a) => a.name === value) ? [{ name: value, deploysVia: [] as DeployApp["deploysVia"] }, ...deployApps] : deployApps;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={FIELD_CLASS} style={{ maxWidth: 280 }} value={sel} onChange={(e) => setSel(e.target.value)}>
        <option value="">— none —</option>
        {options.map((a) => (
          <option key={a.name} value={a.name}>
            {a.name}
            {a.deploysVia.length ? ` (${a.deploysVia.join(", ")})` : ""}
          </option>
        ))}
      </select>
      <button type="button" className={BTN_PRIMARY_CLASS} disabled={pending || sel === value} onClick={() => onSubmit(sel || null)}>
        {pending ? "Saving…" : submitLabel}
      </button>
    </div>
  );
}

function AddForm({ onData, onClose }: { onData: (d: VulnerabilitiesResponse) => void; onClose: () => void }) {
  const { notify } = useToast();
  const [app, setApp] = useState("");
  const [scanType, setScanType] = useState("SAST");
  const empty = (): Record<VulnSeverity, string> => ({ critical: "", high: "", medium: "", low: "", informational: "" });
  const [counts, setCounts] = useState<Record<VulnSeverity, string>>(empty);

  const save = useMutation({
    mutationFn: () =>
      addVulnerability({
        app: app.trim(),
        scanType,
        critical: Number(counts.critical) || 0,
        high: Number(counts.high) || 0,
        medium: Number(counts.medium) || 0,
        low: Number(counts.low) || 0,
        informational: Number(counts.informational) || 0,
      }),
    onSuccess: (d) => {
      onData(d);
      notify(`Saved ${app.trim()}`, "success");
      setApp("");
      setCounts(empty());
      onClose();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  return (
    <div className={`${CARD_CLASS} flex flex-wrap items-end gap-3 p-3`}>
      <input className={FIELD_CLASS} style={{ maxWidth: 200 }} value={app} onChange={(e) => setApp(e.target.value)} placeholder="app name" />
      <select className={FIELD_CLASS} value={scanType} onChange={(e) => setScanType(e.target.value)}>
        <option value="SAST">SAST</option>
        <option value="DAST">DAST</option>
        <option value="SCA">SCA</option>
        <option value="IAST">IAST</option>
        <option value="">(none)</option>
      </select>
      {VULN_SEVERITIES.map((s) => (
        <label key={s} className="flex flex-col text-xs text-gray-500 capitalize">
          {s === "informational" ? "info" : s}
          <input
            type="number"
            min={0}
            className={`${FIELD_CLASS} w-20`}
            value={counts[s]}
            onChange={(e) => setCounts((c) => ({ ...c, [s]: e.target.value }))}
            placeholder="0"
          />
        </label>
      ))}
      <button type="button" className={BTN_PRIMARY_CLASS} disabled={!app.trim() || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
