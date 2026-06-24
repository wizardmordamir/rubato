import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DisclosureButton, useCopyToClipboard } from "cursedbelt/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useRegisterBreadcrumbLabel } from "../breadcrumbs";
import type { BrowserChoice, DetectedBrowser, Step, Target } from "@shared/automation";
import { insertSmartWaits, type RunSpeed } from "@shared/pacing";
import { manifestToMoments } from "@shared/timeline";
import {
  type Automation,
  type AutomationRunRecord,
  captureExportUrl,
  closeAutomationBrowser,
  exportCaptureText,
  fetchAutomation,
  fetchCaptureDraft,
  fetchCaptureManifest,
  runAutomation,
  saveAutomation,
  sessionBrowsers,
  sessionCapture,
  sessionLaunch,
  sessionPicker,
  sessionRecorder,
  sessionSnapshot,
  sessionStatus,
  sessionStop,
  sessionTestSelector,
} from "../api";
import { BuilderContext, type BuilderCtx, uid } from "../builder/model";
import { RunSummary, stepLabel } from "../builder/RunSummary";
import { type ResultMap, StepList } from "../builder/StepList";
import { TimelinePlayer } from "../builder/TimelinePlayer";
import { RUN_SPEEDS, speedLabel } from "../builder/useAutomationRunner";
import { useStepRunner } from "../builder/useStepRunner";
import { Alert, OpenPathButton, Tooltip } from "../components";
import { useConfirm } from "../confirm";
import { useServerEvent } from "../liveBus";
import { usePersistentBoolean, usePersistentString } from "../persisted";
import { useToast } from "../toast";

interface Draft {
  id?: string;
  name: string;
  description: string;
  folder: string;
  startUrl: string;
  steps: Step[];
  /** Capture track recorded alongside the steps (HTML+screenshot timeline). */
  capture?: Automation["capture"];
}

const EMPTY: Draft = { name: "New automation", description: "", folder: "", startUrl: "", steps: [] };

/** Serialize the persisted shape of a draft, to detect unsaved changes. */
const snapshot = (d: Draft) =>
  JSON.stringify({ name: d.name, description: d.description, folder: d.folder, startUrl: d.startUrl, steps: d.steps });

const input =
  "rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30 dark:border-gray-700 dark:bg-gray-900";

export function BuilderPage({ headerActions }: { headerActions?: ReactNode } = {}) {
  const { id = "new" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { notify } = useToast();
  const { copy } = useCopyToClipboard();
  const confirm = useConfirm();

  const [draft, setDraft] = useState<Draft>(EMPTY);
  useRegisterBreadcrumbLabel(id === "new" ? undefined : draft.name || undefined);
  const [launched, setLaunched] = useState(false);
  const [recording, setRecording] = useState(false);
  // "Capture screens" — also bundle HTML + a screenshot per moment into a timeline.
  const [capturing, setCapturing] = useState(false);
  // Running moment count for the active capture track (live, via session:captured).
  const [captureCount, setCaptureCount] = useState(0);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sessionUrl, setSessionUrl] = useState("");
  // Launch options persist across reloads (sticky choices).
  const [recordOnLaunch, setRecordOnLaunch] = usePersistentBoolean("rubato.session.autoRecord", true);
  const [captureOnLaunch, setCaptureOnLaunch] = usePersistentBoolean("rubato.session.autoCapture", true);
  const [results, setResults] = useState<ResultMap>({});
  const [running, setRunning] = useState(false);
  // The most recent completed run, surfaced in the RunSummary panel.
  const [lastRun, setLastRun] = useState<AutomationRunRecord | null>(null);
  // Run options persist across reloads (localStorage), so they're sticky choices.
  const [runHeadless, setRunHeadless] = usePersistentBoolean("rubato.run.headless", true);
  // Headed only: keep the browser open after the run (not just on failure).
  const [runKeepOpen, setRunKeepOpen] = usePersistentBoolean("rubato.run.keepOpen", false);
  const [runSpeed, setRunSpeed] = usePersistentString<RunSpeed>("rubato.run.speed", "off", RUN_SPEEDS);
  const BROWSER_CHOICES = ["", "chrome", "chromium", "firefox", "edge", "webkit"] as const;
  const [runBrowserRaw, setRunBrowserRaw] = usePersistentString<BrowserChoice | "">("rubato.run.browser", "", BROWSER_CHOICES);
  const runBrowser: BrowserChoice | undefined = runBrowserRaw || undefined;
  const setRunBrowser = (v: BrowserChoice | undefined) => setRunBrowserRaw(v ?? "");
  // Browser choice for the headed build session (launch button).
  const [buildBrowserRaw, setBuildBrowserRaw] = usePersistentString<BrowserChoice | "">("rubato.build.browser", "", BROWSER_CHOICES);
  const buildBrowser: BrowserChoice | undefined = buildBrowserRaw || undefined;
  const setBuildBrowser = (v: BrowserChoice | undefined) => setBuildBrowserRaw(v ?? "");
  const [detectedBrowsers, setDetectedBrowsers] = useState<DetectedBrowser[]>([]);
  const stepper = useStepRunner();
  // A headed run's browser was left open (on failure, or because keepOpen was set).
  const [heldOpen, setHeldOpen] = useState(false);
  const pendingPick = useRef<((t: Target) => void) | null>(null);
  // Latest draft (for callbacks that shouldn't close over a stale value).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Snapshot of what's been persisted; `dirty` is true when the draft diverges.
  const savedSnap = useRef(snapshot(EMPTY));
  const dirty = snapshot(draft) !== savedSnap.current;
  // Step count when the current recording session began, for a stop summary.
  const recordStart = useRef(0);

  // Load an existing automation.
  const { data } = useQuery({
    queryKey: ["automation", id],
    queryFn: () => fetchAutomation(id),
    enabled: id !== "new",
  });
  useEffect(() => {
    if (!data) return;
    const loaded: Draft = { id: data.id, name: data.name, description: data.description ?? "", folder: data.folder ?? "", startUrl: data.startUrl ?? "", steps: data.steps, capture: data.capture };
    setDraft(loaded);
    savedSnap.current = snapshot(loaded);
    setCaptureCount(data.capture?.count ?? 0);
  }, [data]);

  // The capture track (HTML+screenshot timeline) for the current draft/session, if
  // any — drives the inspectable timeline panel. Re-fetched live as moments land.
  const captureId = draft.capture?.id;
  const captureManifest = useQuery({
    queryKey: ["capture", captureId],
    queryFn: () => fetchCaptureManifest(captureId as string),
    enabled: !!captureId,
  });

  // Detect available browsers once on mount.
  useEffect(() => {
    sessionBrowsers().then(setDetectedBrowsers).catch(() => {});
  }, []);

  // Hydrate the toolbar from a session that's already live (e.g. after a reload
  // mid-recording), so Record/Capture state + the moment count are restored.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    void sessionStatus()
      .then((st) => {
        if (!st.active) return;
        setLaunched(true);
        setRecording(st.recording);
        setCapturing(st.capturing);
        setCaptureCount(st.captureCount);
        if (st.url) setSessionUrl(st.url);
        if (st.captureId && !draftRef.current.capture) {
          setDraft((d) => ({ ...d, capture: { id: st.captureId as string, count: st.captureCount, startedAt: Date.now() } }));
        }
      })
      .catch(() => {});
  }, []);

  // "Open in builder" on a stored capture (Browser library) → lift it into an
  // editable, unsaved draft that keeps its capture track. Saving promotes it to a
  // real automation. This is how the (formerly immutable) captures become editable.
  const fromCapture = useSearchParams()[0].get("fromCapture");
  const liftedRef = useRef(false);
  useEffect(() => {
    if (!fromCapture || id !== "new" || liftedRef.current) return;
    liftedRef.current = true;
    void fetchCaptureDraft(fromCapture)
      .then((d) => {
        const loaded: Draft = {
          name: d.name,
          description: d.description ?? "",
          folder: d.folder ?? "",
          startUrl: d.startUrl ?? "",
          steps: d.steps,
          capture: d.capture,
        };
        setDraft(loaded);
        setCaptureCount(d.capture?.count ?? 0);
        setTimelineOpen(true);
      })
      .catch((err) => notify(err instanceof Error ? err.message : "could not open capture", "error"));
  }, [fromCapture, id, notify]);

  // Stop the headed build browser AND any held failure browser when leaving.
  useEffect(
    () => () => {
      void sessionStop().catch(() => {});
      void closeAutomationBrowser().catch(() => {});
    },
    [],
  );

  useServerEvent((e) => {
    switch (e.type) {
      case "session:picked":
        pendingPick.current?.(e.target);
        pendingPick.current = null;
        setPicking(false);
        break;
      case "session:recorded-step":
        setDraft((d) => ({ ...d, steps: [...d.steps, e.step] }));
        break;
      case "session:navigated":
        setSessionUrl(e.url);
        break;
      case "session:captured":
        setCaptureCount(e.count);
        // Keep the draft's capture ref in step with the live track: adopt a fresh
        // track's id on its first moment, and keep its `count` current as moments
        // land (it used to stick at the first value, so saved flows recorded count 0).
        setDraft((d) => ({
          ...d,
          capture: { id: e.id, count: e.count, startedAt: d.capture?.id === e.id ? d.capture.startedAt : Date.now() },
        }));
        qc.invalidateQueries({ queryKey: ["capture", e.id] });
        break;
      case "session:closed":
        setLaunched(false);
        setRecording(false);
        setCapturing(false);
        setPicking(false);
        break;
      case "automation:run:started":
        setResults({});
        setRunning(true);
        setHeldOpen(false);
        setLastRun(null);
        break;
      case "automation:step":
        setResults((r) => ({ ...r, [e.result.index]: e.result }));
        break;
      case "automation:run:completed": {
        setRunning(false);
        setHeldOpen(!!e.heldOpen);
        setLastRun(e.run);
        // Point the user at the run summary, which shows the failing step's details.
        if (e.run.status === "failed") {
          const failStep = e.run.steps.find((s) => s.status === "failed");
          notify(failStep ? `Run failed at ${stepLabel(failStep)} — see the run summary above the steps` : "Run failed before any step — see the run summary above the steps", "error");
        } else {
          notify(`Run passed (${e.run.steps.length} step${e.run.steps.length === 1 ? "" : "s"})`, "success");
        }
        break;
      }
      default:
        break;
    }
  });

  const ctx: BuilderCtx = {
    launched,
    recording,
    picking,
    pickInto: (apply) => {
      pendingPick.current = apply;
      setPicking(true);
      sessionPicker(true).catch((err) => notify(String(err), "error"));
    },
    test: (t) => sessionTestSelector(t),
  };

  // Adopt the live session's capture track id (from a sessionCapture/snapshot
  // response) so the timeline panel + Save know which capture this flow carries.
  const adoptCapture = (captureId: string | undefined, count: number) => {
    setCaptureCount(count);
    if (captureId) {
      setDraft((d) => (d.capture?.id === captureId ? d : { ...d, capture: { id: captureId, count, startedAt: Date.now() } }));
    }
  };

  const launch = async () => {
    if (!draft.startUrl) return notify("Set a start URL first", "error");
    try {
      await sessionLaunch(draft.startUrl, false, buildBrowser);
      setLaunched(true);
      setSessionUrl(draft.startUrl);
      recordStart.current = draftRef.current.steps.length;
      // Default: start recording (and capturing screens) the moment the browser
      // opens, so there's no launch → switch-back → click-Record round-trip.
      if (captureOnLaunch) {
        const st = await sessionCapture(true); // records steps + captures screens
        setRecording(true);
        setCapturing(true);
        adoptCapture(st.captureId, st.captureCount);
        setTimelineOpen(true);
        notify("Browser launched — recording steps & capturing screens", "success");
      } else if (recordOnLaunch) {
        await sessionRecorder(true);
        setRecording(true);
        notify("Browser launched — recording your interactions", "success");
      } else {
        notify("Browser launched — interact in the new window", "success");
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : "launch failed", "error");
    }
  };

  const toggleRecord = async () => {
    const next = !recording;
    try {
      await sessionRecorder(next);
      setRecording(next);
      if (next) {
        recordStart.current = draftRef.current.steps.length;
      } else {
        // Stopping the recorder also stops screen capture (capture builds on it).
        setCapturing(false);
        // Recorded steps land in the draft (the Steps list) — they aren't saved
        // anywhere until you click Save. Say so, so the recording isn't lost.
        const added = draftRef.current.steps.length - recordStart.current;
        if (added > 0) notify(`Recorded ${added} step${added === 1 ? "" : "s"} — click Save to keep them, Run to replay.`, "success");
        else notify("No steps were recorded.", "info");
      }
    } catch (err) {
      notify(String(err), "error");
    }
  };

  // Toggle screen capture (HTML + screenshot timeline) without stopping the
  // recorder. Turning it on implies recording, so reflect that in the toolbar.
  const toggleCapture = async () => {
    const next = !capturing;
    try {
      if (next && !recording) recordStart.current = draftRef.current.steps.length;
      const st = await sessionCapture(next);
      setCapturing(next);
      if (next) {
        setRecording(true);
        setTimelineOpen(true);
      }
      adoptCapture(next ? st.captureId : draft.capture?.id, st.captureCount);
    } catch (err) {
      notify(String(err), "error");
    }
  };

  const snapshotNow = async () => {
    try {
      const st = await sessionSnapshot();
      setCaptureCount(st.captureCount);
      qc.invalidateQueries({ queryKey: ["capture", captureId] });
    } catch (err) {
      notify(String(err), "error");
    }
  };

  const stop = async () => {
    await sessionStop().catch(() => {});
    setLaunched(false);
    setRecording(false);
    setCapturing(false);
    setPicking(false);
    if (captureId) qc.invalidateQueries({ queryKey: ["capture", captureId] });
  };

  // Recover steps from the capture when the live recorder stream didn't populate
  // them (e.g. the builder was reopened on a captured flow, or a reload dropped the
  // in-memory steps). The capture manifest holds the durable action records — lift
  // them into the editable Steps list (cleaned), keeping the user's other edits.
  const generateSteps = async () => {
    if (!captureId) return;
    try {
      const d = await fetchCaptureDraft(captureId);
      if (!d.steps.length) {
        notify("This capture has no replayable actions to turn into steps.", "info");
        return;
      }
      setDraft((cur) => ({ ...cur, steps: d.steps, startUrl: cur.startUrl || d.startUrl || "" }));
      notify(`Generated ${d.steps.length} step${d.steps.length === 1 ? "" : "s"} from the capture — review, then Save.`, "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : "could not generate steps", "error");
    }
  };

  // Re-derive when the draft ALREADY has steps — confirm first so a user never
  // silently loses hand-edits (the overwrite only touches the in-memory draft, so
  // they can still discard before saving). The empty-steps callout below skips the
  // confirm since there's nothing to clobber.
  const regenerateSteps = async () => {
    const ok = await confirm({
      prompt: "Regenerate steps from the capture?",
      flavorText:
        "This replaces the steps below with ones re-derived from the recorded capture. Any hand-edited steps will be overwritten (you can still discard before saving).",
      confirmText: "Regenerate",
    });
    if (ok) generateSteps();
  };

  const save = useMutation({
    mutationFn: () => saveAutomation({ id: draft.id, name: draft.name, description: draft.description, folder: draft.folder || undefined, startUrl: draft.startUrl, steps: draft.steps, capture: draft.capture }),
    onSuccess: (saved: Automation) => {
      notify(`Saved to ~/.rubato/automations/${saved.id}.json`, "success");
      setDraft((d) => ({ ...d, id: saved.id }));
      savedSnap.current = snapshot(draftRef.current);
      qc.invalidateQueries({ queryKey: ["automations"] });
      if (id === "new") nav(`/automations/${saved.id}/edit`, { replace: true });
    },
    onError: (e) => notify(e instanceof Error ? e.message : "save failed", "error"),
  });

  const buildAutomation = (): Automation => ({
    id: draft.id ?? "draft",
    name: draft.name,
    description: draft.description,
    startUrl: draft.startUrl,
    steps: draft.steps,
    createdAt: 0,
    updatedAt: 0,
  });

  const run = async () => {
    try {
      const automation = buildAutomation();
      await runAutomation({ automation, headless: runHeadless, keepOpen: runKeepOpen, speed: runSpeed, browser: runBrowser });
      notify("Run started…");
    } catch (err) {
      notify(err instanceof Error ? err.message : "run failed", "error");
    }
  };

  const closeHeld = async () => {
    await closeAutomationBrowser().catch(() => {});
    setHeldOpen(false);
  };

  // Replay-from-list: a `?run=1` link (the Run button on the Automations page)
  // auto-fires one run once the automation has loaded, then drops the param.
  const [searchParams, setSearchParams] = useSearchParams();
  const runRef = useRef(run);
  runRef.current = run;
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (searchParams.get("run") !== "1" || autoRanRef.current) return;
    // Wait until the loaded automation is actually in the draft, so the run uses
    // its steps/startUrl rather than the empty initial draft.
    if (id !== "new" && draft.id !== id) return;
    autoRanRef.current = true;
    setSearchParams({}, { replace: true });
    void runRef.current();
  }, [searchParams, setSearchParams, draft.id, id]);

  return (
    <BuilderContext.Provider value={ctx}>
      <div className="mx-auto max-w-3xl">
        {id !== "new" && draft.id && (
          <div className="mb-3 flex items-center gap-3 text-sm">
            <button type="button" onClick={() => nav(`/automations/${draft.id}`)} className="text-gray-400 hover:underline">
              View
            </button>
          </div>
        )}

        <div className="space-y-2">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Name" className={`${input} w-full text-lg font-semibold`} />
          <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Description (optional)" className={`${input} w-full`} />
          <input value={draft.folder} onChange={(e) => setDraft({ ...draft, folder: e.target.value })} placeholder="Folder / category (optional — e.g. Staging, Login flows)" className={`${input} w-full`} />
          <input value={draft.startUrl} onChange={(e) => setDraft({ ...draft, startUrl: e.target.value })} placeholder="Start URL (e.g. https://example.com/login)" className={`${input} w-full font-mono`} />
        </div>

        {/* Session toolbar */}
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900">
          {!launched ? (
            <>
              <button type="button" onClick={launch} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover">
                Launch browser
              </button>
              {detectedBrowsers.length > 0 && (
                <Tooltip content="Which browser to open for building">
                  <label className="flex items-center gap-1 text-xs text-gray-500">
                    in
                    <select
                      value={buildBrowserRaw}
                      onChange={(e) => setBuildBrowser((e.target.value as BrowserChoice) || undefined)}
                      className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-950"
                    >
                      <option value="">default</option>
                      {detectedBrowsers.map((b) => (
                        <option key={b.id} value={b.id} disabled={!b.available}>
                          {b.label}{!b.available ? " (not found)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                </Tooltip>
              )}
              {/* Start recording (and capturing screens) the instant the browser opens. */}
              <Tooltip content="Start recording your interactions into steps the moment the browser launches.">
                <label className="flex items-center gap-1 text-xs text-gray-500">
                  <input type="checkbox" checked={recordOnLaunch} onChange={(e) => setRecordOnLaunch(e.target.checked)} />
                  record on launch
                </label>
              </Tooltip>
              <Tooltip content="Also bundle each moment's page HTML + a screenshot into an inspectable, exportable timeline. Implies recording.">
                <label className="flex items-center gap-1 text-xs text-gray-500">
                  <input
                    type="checkbox"
                    checked={captureOnLaunch}
                    onChange={(e) => {
                      setCaptureOnLaunch(e.target.checked);
                      if (e.target.checked) setRecordOnLaunch(true); // capture implies recording
                    }}
                  />
                  capture screens
                </label>
              </Tooltip>
            </>
          ) : (
            <>
              <button type="button" onClick={toggleRecord} className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors ${recording ? "bg-red-600 hover:bg-red-700" : "bg-gray-700 hover:bg-gray-600"}`}>
                {recording ? "■ Stop recording" : "● Record"}
              </button>
              <Tooltip content="Bundle each moment's HTML + a screenshot into an inspectable timeline (implies recording).">
                <button
                  type="button"
                  onClick={toggleCapture}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${capturing ? "bg-accent text-white hover:bg-accent-hover" : "border border-gray-300 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"}`}
                >
                  {capturing ? `◉ Capturing${captureCount ? ` · ${captureCount}` : ""}` : "○ Capture screens"}
                </button>
              </Tooltip>
              {capturing && (
                <Tooltip content="Bundle the current screen now (a read-only screen with no interaction).">
                  <button type="button" onClick={snapshotNow} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm transition-colors hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800">
                    Snapshot now
                  </button>
                </Tooltip>
              )}
              <button type="button" onClick={stop} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm transition-colors hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800">
                Close browser
              </button>
              <Tooltip content={sessionUrl}>
                <span className="truncate font-mono text-xs text-gray-400">
                  {sessionUrl}
                </span>
              </Tooltip>
            </>
          )}
        </div>

        {picking && (
          <Alert tone="warning" className="mt-2">
            Click an element in the browser window to pick its selector…
          </Alert>
        )}
        {recording && (
          <p className="mt-2 text-xs text-gray-400">
            Recording — your clicks, fills, selects and checkboxes in the browser become steps below
            {capturing ? ", and each screen is captured into the timeline" : ""}. Click <b>Save</b> when done to keep them.
          </p>
        )}

        {/* Capture timeline — the inspectable HTML+screenshot evidence for this flow. */}
        {captureId && (captureManifest.data?.records.length ?? 0) > 0 && (
          <div className="mt-3 rounded-xl border border-gray-200 dark:border-gray-800">
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 p-2 dark:border-gray-800">
              <DisclosureButton open={timelineOpen} onToggle={() => setTimelineOpen((o) => !o)} className="text-sm font-medium text-gray-600 hover:text-accent dark:text-gray-300">
                Captured timeline · {captureManifest.data?.records.length ?? captureCount} screen
                {(captureManifest.data?.records.length ?? captureCount) === 1 ? "" : "s"}
              </DisclosureButton>
              <span className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const { token } = await exportCaptureText(captureId);
                      if (await copy(token)) notify("Copied a shareable capture string to the clipboard.", "success");
                      else notify("Couldn't copy to clipboard", "error");
                    } catch (err) {
                      notify(err instanceof Error ? err.message : "export failed", "error");
                    }
                  }}
                  className="text-xs text-gray-400 hover:text-accent"
                >
                  copy string
                </button>
                <a className="text-xs text-gray-400 hover:text-accent" href={captureExportUrl(captureId)}>
                  download bundle
                </a>
              </span>
            </div>
            {timelineOpen && (
              <div className="h-[28rem]">
                {captureManifest.data ? <TimelinePlayer moments={manifestToMoments(captureManifest.data)} /> : <p className="p-4 text-sm text-gray-500">Loading…</p>}
              </div>
            )}
          </div>
        )}

        {heldOpen && (
          <Alert
            tone={lastRun?.status === "failed" ? "error" : "info"}
            className="mt-2"
            actions={
              <button
                type="button"
                onClick={closeHeld}
                className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-black/5 dark:border-gray-600 dark:hover:bg-white/10"
              >
                Close browser
              </button>
            }
          >
            {lastRun?.status === "failed"
              ? "A step failed — the browser was left open so you can inspect the page that broke."
              : "The browser was kept open so you can inspect the page."}
          </Alert>
        )}

        {/* Run outcome — the place to review what passed and what failed. */}
        {(running || lastRun) && (
          <div className="mt-3">
            <RunSummary running={running} run={lastRun} />
          </div>
        )}

        {/* Steps — pb gives the Add-step button clearance to scroll above the
            sticky action bar below (it floats over the last in-flow content). */}
        <div className="mt-4 pb-28">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-500">Steps</span>
            <div className="ml-auto flex items-center gap-2">
              {draft.steps.length > 0 && captureId && (captureManifest.data?.records.length ?? 0) > 0 && (
                <Tooltip content="Re-derive the steps from the recorded capture (overwrites the steps below)">
                  <button
                    type="button"
                    onClick={regenerateSteps}
                    className="rounded-md border border-gray-300 px-2 py-0.5 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    ↻ Regenerate from capture
                  </button>
                </Tooltip>
              )}
              <Tooltip content="Insert wait steps after clicks and navigation so a replay is slow enough to watch">
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, steps: insertSmartWaits(draft.steps, "slow") })}
                  className="rounded-md border border-gray-300 px-2 py-0.5 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  + Add smart waits
                </button>
              </Tooltip>
            </div>
          </div>
          {draft.steps.length === 0 && captureId && (captureManifest.data?.records.length ?? 0) > 0 && (
            <Alert
              tone="warning"
              className="mb-3"
              actions={
                <button
                  type="button"
                  onClick={generateSteps}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
                >
                  Generate steps from capture
                </button>
              }
            >
              This flow has a capture ({captureManifest.data?.records.length} screen
              {(captureManifest.data?.records.length ?? 0) === 1 ? "" : "s"}) but no steps — generate them from the recorded actions.
            </Alert>
          )}
          <StepList steps={draft.steps} onChange={(steps) => setDraft({ ...draft, steps })} results={results} />
        </div>

        {/* Actions */}
        <div className="sticky bottom-0 mt-4 border-t border-gray-200 bg-gray-50 py-3 dark:border-gray-800 dark:bg-gray-950">
          <div className="flex items-center gap-2">
            <Tooltip content="Replay the steps above">
              <button type="button" onClick={run} disabled={running} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">
                {running ? "Running…" : "▶ Run"}
              </button>
            </Tooltip>
            {/* Live step-through: run one action at a time in a headed browser. */}
            {stepper.active ? (
              <div className="flex items-center gap-1">
                {stepper.mode === "play" ? (
                  <StepBtn onClick={stepper.pause}>⏸ Pause</StepBtn>
                ) : (
                  <>
                    <StepBtn onClick={stepper.next}>⤼ Next</StepBtn>
                    <StepBtn onClick={stepper.play}>▶ Play</StepBtn>
                  </>
                )}
                <StepBtn onClick={stepper.restart}>↺ Restart</StepBtn>
                <StepBtn onClick={stepper.stop}>■ Stop</StepBtn>
                {stepper.cursor != null && <span className="font-mono text-gray-400 text-xs">@ {stepper.cursor}</span>}
              </div>
            ) : (
              <Tooltip content="Step through the automation one action at a time in a visible browser">
                <button
                  type="button"
                  onClick={() => stepper.start(buildAutomation(), runSpeed === "off" ? "slow" : runSpeed)}
                  disabled={running || draft.steps.length === 0}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  ⤼ Step
                </button>
              </Tooltip>
            )}
            <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm font-medium transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800">
              Save
            </button>
            {dirty && (
              <Tooltip content="You have changes that aren't saved yet">
                <span className="text-xs font-medium text-amber-600 dark:text-amber-500">
                  • Unsaved
                </span>
              </Tooltip>
            )}
            {/* Friend-app slot: extra actions an embedder injects into the builder's
                action bar. Undefined for rubato's own app → unchanged. */}
            {headerActions}
            <Tooltip content="Uncheck to run with a visible browser — it stays open on failure so you can inspect the page.">
              <label className="ml-auto flex items-center gap-1 text-xs text-gray-500">
                <input type="checkbox" checked={runHeadless} onChange={(e) => setRunHeadless(e.target.checked)} />
                headless
              </label>
            </Tooltip>
            {!runHeadless && (
              <Tooltip content="Leave the visible browser open after the run (not just on failure) so you can inspect the page.">
                <label className="flex items-center gap-1 text-xs text-gray-500">
                  <input type="checkbox" checked={runKeepOpen} onChange={(e) => setRunKeepOpen(e.target.checked)} />
                  keep open
                </label>
              </Tooltip>
            )}
            <Tooltip content="Pause between steps so you can watch a run.">
              <label className="flex items-center gap-1 text-xs text-gray-500">
              speed
              <select
                value={runSpeed}
                onChange={(e) => setRunSpeed(e.target.value as RunSpeed)}
                className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-950"
              >
                {RUN_SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {speedLabel(s)}
                  </option>
                ))}
              </select>
              </label>
            </Tooltip>
            {detectedBrowsers.length > 0 && (
              <Tooltip content="Which browser to run the automation in">
                <label className="flex items-center gap-1 text-xs text-gray-500">
                  browser
                  <select
                    value={runBrowserRaw}
                    onChange={(e) => setRunBrowser((e.target.value as BrowserChoice) || undefined)}
                    className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-950"
                  >
                    <option value="">default</option>
                    {detectedBrowsers.map((b) => (
                      <option key={b.id} value={b.id} disabled={!b.available}>
                        {b.label}{!b.available ? " (not found)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </Tooltip>
            )}
          </div>
          <p className="mt-1.5 text-xs text-gray-400">
            <b>Save</b> stores this under <span className="font-mono">~/.rubato/automations/</span>
            <OpenPathButton path="~/.rubato/automations" /> (and on the Automations list). <b>Run</b> replays the steps and shows each result inline.
          </p>
        </div>
      </div>
    </BuilderContext.Provider>
  );
}

function StepBtn({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm transition-colors hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
    >
      {children}
    </button>
  );
}
