import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCopyToClipboard } from "cwip/react";
import { type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { CaptureSummary } from "@shared/capture";
import {
  type Automation,
  captureExportUrl,
  deleteAutomation,
  deleteCapture,
  exportCaptureText,
  fetchAutomations,
  fetchCaptures,
  generateStepsFromCapture,
  importCapture,
  importCaptureText,
} from "../api";
import { RunControls, RunPanel } from "../builder/RunControls";
import { useAutomationRunner } from "../builder/useAutomationRunner";
import {
  Alert,
  BTN_GHOST_CLASS,
  BTN_PRIMARY_CLASS,
  CARD_CLASS,
  CARD_INTERACTIVE_CLASS,
  FIELD_CLASS,
  PageHeading,
  Tooltip,
} from "../components";
import { useConfirm } from "../confirm";
import { IconPlus, IconSliders, IconTrash } from "../icons";
import { useToast } from "../toast";

/**
 * The Browser library — every browser flow in one place. A flow is an Automation
 * (editable steps) that may carry a capture track (an HTML+screenshot timeline).
 * Standalone capture sessions (recorded for inspection, or imported from another
 * machine) are listed here too and are made editable by opening them in the
 * builder, which lifts their steps into an editable draft that keeps the timeline.
 *
 * `showSharing` controls the string-based capture sharing features (seed input,
 * "Copy string" button, "Import string" panel). Off by default — QA plugin apps
 * don't expose it; rubato's own app passes `showSharing` to enable it.
 */
export function AutomationsPage({
  headerActions,
  showSharing = false,
}: {
  headerActions?: ReactNode;
  showSharing?: boolean;
} = {}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { notify } = useToast();
  const { copy } = useCopyToClipboard();
  const confirm = useConfirm();
  const runner = useAutomationRunner();
  const { data = [] } = useQuery({ queryKey: ["automations"], queryFn: fetchAutomations });
  const { data: captures = [] } = useQuery({ queryKey: ["captures"], queryFn: fetchCaptures });

  // Captures already promoted to a flow are shown via that flow's badge — only the
  // not-yet-a-flow ones get their own row here, so nothing is listed twice.
  const linkedCaptureIds = new Set(data.map((a) => a.capture?.id).filter(Boolean));
  const standaloneCaptures = captures.filter((c) => !linkedCaptureIds.has(c.id));

  const refreshCaptures = () => qc.invalidateQueries({ queryKey: ["captures"] });

  const del = useMutation({
    mutationFn: (id: string) => deleteAutomation(id),
    onSuccess: () => {
      notify("Deleted", "success");
      qc.invalidateQueries({ queryKey: ["automations"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "delete failed", "error"),
  });

  // A flow can land with a capture track but an empty Steps list (the recorder's
  // live step stream is builder-memory only). The capture manifest is the durable
  // record, so a broken flow can self-heal straight from the library — no need to
  // open it first. (If the capture has nothing replayable, the endpoint reports
  // generated:0 and the flow is left untouched.)
  const genSteps = useMutation({
    mutationFn: (id: string) => generateStepsFromCapture(id),
    onSuccess: (res) => {
      if (res.generated === 0) {
        notify("This capture has no replayable actions to turn into steps.", "info");
        return;
      }
      notify(`Generated ${res.generated} step${res.generated === 1 ? "" : "s"} from the capture.`, "success");
      qc.invalidateQueries({ queryKey: ["automations"] });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "could not generate steps", "error"),
  });

  // Secure shareable-string transport (showSharing only): a seed encrypts the
  // exported string and is required to import it (cwip sealToText/openFromText).
  const [seed, setSeed] = useState("");
  const [importToken, setImportToken] = useState("");
  const importBundleFile = useMutation({ mutationFn: (f: File) => importCapture(f), onSuccess: refreshCaptures });
  const importString = useMutation({
    mutationFn: () => importCaptureText(importToken.trim(), seed || undefined),
    onSuccess: () => {
      setImportToken("");
      refreshCaptures();
    },
    onError: (e) => notify(e instanceof Error ? e.message : "import failed", "error"),
  });
  const removeCapture = useMutation({ mutationFn: (id: string) => deleteCapture(id), onSuccess: refreshCaptures });
  const copyString = useMutation({
    mutationFn: async (id: string) => {
      const { token } = await exportCaptureText(id, seed || undefined);
      if (!(await copy(token))) throw new Error("Couldn't copy to clipboard");
    },
    onSuccess: () => notify("Copied a shareable capture string to the clipboard.", "success"),
    onError: (e) => notify(e instanceof Error ? e.message : "export failed", "error"),
  });

  // Group automations by folder (empty string → uncategorized, rendered last).
  const folderMap = new Map<string, Automation[]>();
  for (const a of data) {
    const key = a.folder?.trim() || "";
    const list = folderMap.get(key) ?? [];
    list.push(a);
    folderMap.set(key, list);
  }
  const namedFolders = [...folderMap.keys()].filter(Boolean).sort();
  const folders: Array<{ label: string; items: Automation[] }> = [
    ...namedFolders.map((f) => ({ label: f, items: folderMap.get(f)! })),
    ...(folderMap.has("") ? [{ label: "", items: folderMap.get("")! }] : []),
  ];

  return (
    <div>
      <PageHeading
        title="Browser"
        count={data.length}
        actions={
          <div className="flex items-center gap-2">
            <Tooltip content="Manage automation environments (variable sets for switching dev/staging/prod)">
              <Link to="/automations/environments" className={BTN_GHOST_CLASS}>
                <IconSliders size={14} /> Environments
              </Link>
            </Tooltip>
            <Tooltip multiline content="Loads a capture bundle file (.gz, exported as a bundle from another machine) into your library as a captured session you can open in the builder.">
              <label className={BTN_GHOST_CLASS}>
                Import capture…
                <input
                  type="file"
                  accept=".gz,application/gzip"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importBundleFile.mutate(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </Tooltip>
            <Tooltip multiline content="Creates a new browser flow — a Playwright automation you build by launching a real browser and recording your clicks/fills into editable steps (optionally capturing a screenshot timeline). Save it to replay or export it later.">
              <button type="button" onClick={() => nav("/automations/new")} className={BTN_PRIMARY_CLASS}>
                <IconPlus size={14} /> New flow
              </button>
            </Tooltip>
            {/* Friend-app slot: extra actions an embedder injects into this page's
                action bar. Undefined for rubato's own app → unchanged. */}
            {headerActions}
          </div>
        }
      />
      <p className="mb-4 text-xs text-gray-400">
        Build a Playwright flow visually — launch a browser, record interactions into steps, capture each screen, run it,
        and save it. Uses your installed Google Chrome by default.
      </p>

      {data.length === 0 && standaloneCaptures.length === 0 && (
        <p className="text-gray-400">No flows yet — create one to get started.</p>
      )}

      {/* Automations grouped by folder. Single folder-less bucket → no heading. */}
      {folders.map(({ label, items }) => (
        <div key={label || "__none__"} className="mb-6">
          {label && (
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</h2>
          )}
          {!label && namedFolders.length > 0 && (
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Uncategorized</h2>
          )}
          <ul className="space-y-2">
            {items.map((a: Automation) => {
              const active = runner.activeName === a.name;
              return (
                <li key={a.id} className={`${CARD_INTERACTIVE_CLASS} p-3`}>
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <Link to={`/automations/${a.id}`} className="font-medium hover:text-accent">
                        {a.name}
                      </Link>
                      <span className="ml-2 text-xs text-gray-400">{a.steps.length} steps</span>
                      {a.capture && a.capture.count > 0 && (
                        <Tooltip content="This flow has a captured HTML+screenshot timeline">
                          <span
                            className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent"
                          >
                            📷 {a.capture.count}
                          </span>
                        </Tooltip>
                      )}
                      {a.description && <div className="text-xs text-gray-500">{a.description}</div>}
                      {a.startUrl && <div className="truncate font-mono text-xs text-gray-400">{a.startUrl}</div>}
                    </div>
                    <RunControls
                      running={runner.running && active}
                      onRun={(variables, urls, rows) => runner.run(a, variables, urls, rows)}
                      headless={runner.headless}
                      setHeadless={runner.setHeadless}
                      keepOpen={runner.keepOpen}
                      setKeepOpen={runner.setKeepOpen}
                      speed={runner.speed}
                      setSpeed={runner.setSpeed}
                      browser={runner.browser}
                      setBrowser={runner.setBrowser}
                      browsers={runner.browsers}
                      automationId={a.id}
                    />
                    <Tooltip multiline content="Downloads this flow as a @playwright/test .spec.ts file you can drop into another app's e2e suite and run with Playwright directly.">
                      <a
                        href={`/api/automations/${a.id}/export`}
                        download={`${a.id}.spec.ts`}
                        className={BTN_GHOST_CLASS}
                      >
                        ↓ Export
                      </a>
                    </Tooltip>
                    <Link to={`/automations/${a.id}/edit`} className={BTN_GHOST_CLASS}>
                      Edit
                    </Link>
                    <button
                      type="button"
                      onClick={async () => {
                        if (await confirm({ prompt: `Delete the automation "${a.name}"?`, confirmText: "Delete" }))
                          del.mutate(a.id);
                      }}
                      aria-label="Delete"
                      className="inline-flex items-center rounded-lg border border-gray-300 p-1.5 text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 dark:border-gray-700 dark:hover:bg-red-950"
                    >
                      <IconTrash size={15} />
                    </button>
                  </div>
                  {a.steps.length === 0 && a.capture?.id && (
                    <Alert
                      tone="warning"
                      size="sm"
                      className="mt-2"
                      actions={
                        <button
                          type="button"
                          onClick={() => genSteps.mutate(a.id)}
                          disabled={genSteps.isPending && genSteps.variables === a.id}
                          className="rounded-md bg-accent px-2.5 py-1 font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                        >
                          {genSteps.isPending && genSteps.variables === a.id ? "Generating…" : "Generate steps from capture"}
                        </button>
                      }
                    >
                      This flow has a capture but no steps yet — generate them from the recorded actions.
                    </Alert>
                  )}
                  {active && (runner.running || runner.lastRun || runner.heldOpen) && (
                    <div className="mt-3">
                      <RunPanel runner={runner} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {/* Captured sessions not yet turned into a flow. */}
      {standaloneCaptures.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-1 text-sm font-semibold text-gray-500">Captured sessions</h2>
          <p className="mb-3 text-xs text-gray-400">
            Recordings with a screen-by-screen timeline. <b>Open in builder</b> to edit the steps and save it as a flow,
            or export the bundle to inspect it elsewhere.
          </p>
          <ul className="space-y-2">
            {standaloneCaptures.map((c) => (
              <CaptureRow
                key={c.id}
                c={c}
                showSharing={showSharing}
                onOpen={() => nav(`/automations/new?fromCapture=${encodeURIComponent(c.id)}`)}
                onCopyString={() => copyString.mutate(c.id)}
                onDelete={() => removeCapture.mutate(c.id)}
              />
            ))}
          </ul>
        </div>
      )}

      {/* String-based sharing (opt-in via showSharing): seed + import-by-string. */}
      {showSharing && (
        <div className={`${CARD_CLASS} mt-6 flex flex-col gap-2 p-4`}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-gray-500">
              Seed (optional — encrypts the shared string)
              <input
                className={FIELD_CLASS}
                type="password"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                placeholder="a shared password"
              />
            </label>
            <span className="text-xs text-gray-400">
              With a seed, "copy string" is AES-encrypted and the same seed is needed to import it.
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs text-gray-500">
              Import a shared capture string
              <textarea
                className={`${FIELD_CLASS} min-h-16 font-mono text-xs`}
                value={importToken}
                onChange={(e) => setImportToken(e.target.value)}
                placeholder="paste an rbz1_… / rbp1_… token"
              />
            </label>
            <Tooltip multiline content="Decodes the pasted shareable string into a captured session in your library. If the string was encrypted with a seed, enter the same seed above first or the import will fail.">
              <button
                type="button"
                className={BTN_PRIMARY_CLASS}
                disabled={!importToken.trim() || importString.isPending}
                onClick={() => importString.mutate()}
              >
                Import string
              </button>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
}

function CaptureRow({
  c,
  showSharing,
  onOpen,
  onCopyString,
  onDelete,
}: {
  c: CaptureSummary;
  showSharing: boolean;
  onOpen: () => void;
  onCopyString: () => void;
  onDelete: () => void;
}) {
  const confirm = useConfirm();
  return (
    <li className={`${CARD_INTERACTIVE_CLASS} flex items-center gap-3 p-3`}>
      <div className="min-w-0 flex-1">
        {c.note ? (
          <Tooltip content={c.note}>
            <button type="button" onClick={onOpen} className="text-left font-medium hover:text-accent">
              {c.label || c.id}
            </button>
          </Tooltip>
        ) : (
          <button type="button" onClick={onOpen} className="text-left font-medium hover:text-accent">
            {c.label || c.id}
          </button>
        )}
        <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">📷 {c.count}</span>
        {c.note && <div className="truncate text-xs text-gray-500">{c.note}</div>}
      </div>
      <Tooltip multiline content="Opens this recorded session in the builder, lifting its captured screens into editable steps as a draft flow (with its timeline kept) that you can edit and save.">
        <button type="button" onClick={onOpen} className={BTN_GHOST_CLASS}>
          Open in builder
        </button>
      </Tooltip>
      {showSharing && (
        <Tooltip multiline content="Copies this capture as a shareable text string to your clipboard, to paste into someone's "Import string" box. If a seed is set above, the string is AES-encrypted and they need the same seed to import it.">
          <button type="button" onClick={onCopyString} className={BTN_GHOST_CLASS}>
            Copy string
          </button>
        </Tooltip>
      )}
      <Tooltip multiline content="Downloads this capture as a shippable .gz bundle file (HTML + screenshots), to inspect elsewhere or load on another machine via "Import capture…".">
        <a className={BTN_GHOST_CLASS} href={captureExportUrl(c.id)}>
          ↓ Export
        </a>
      </Tooltip>
      <button
        type="button"
        onClick={async () => {
          if (await confirm({ prompt: "Delete this capture?", confirmText: "Delete" })) onDelete();
        }}
        aria-label="Delete"
        className="inline-flex items-center rounded-lg border border-gray-300 p-1.5 text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 dark:border-gray-700 dark:hover:bg-red-950"
      >
        <IconTrash size={15} />
      </button>
    </li>
  );
}
