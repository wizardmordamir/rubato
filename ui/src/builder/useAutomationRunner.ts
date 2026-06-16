// Run an automation from anywhere (the list, the read-only view, the builder)
// without navigating to the editor. Owns the run options (headless / keep open,
// persisted), fires the run, and tracks live progress off the /ws event stream
// so callers can drop a <RunPanel> in and get a verdict + diagnostics inline.

import type { RunSpeed } from "@shared/pacing";
import { useEffect, useRef, useState } from "react";
import { type Automation, type AutomationRunRecord, closeAutomationBrowser, runAutomation } from "../api";
import { useServerEvent } from "../liveBus";
import { usePersistentBoolean, usePersistentString } from "../persisted";
import { useToast } from "../toast";
import { stepLabel } from "./RunSummary";
import type { ResultMap } from "./StepList";

/** Run speeds offered in the UI (also the persisted allow-list). */
export const RUN_SPEEDS: readonly RunSpeed[] = ["off", "slow", "slower"];
/** Human label for a run speed. */
export const speedLabel = (s: RunSpeed): string => (s === "off" ? "full speed" : s === "slow" ? "slow (watch)" : "slower");

export interface AutomationRunner {
  /** Replay this automation with the current options + any preload variables.
   *  `urls` fans across target URLs; `rows` fans across a variable matrix. */
  run: (
    a: Automation,
    variables?: Record<string, string>,
    urls?: string[],
    rows?: Record<string, string>[],
  ) => Promise<void>;
  /** A run is in flight. */
  running: boolean;
  /** Name of the automation currently running / last run (events key on name). */
  activeName: string | null;
  /** Per-step results, keyed by step index (for inline step readouts). */
  results: ResultMap;
  /** The most recent completed run. */
  lastRun: AutomationRunRecord | null;
  /** A headed run left its browser open (on failure, or keep-open). */
  heldOpen: boolean;
  /** Close a held-open browser. */
  closeHeld: () => Promise<void>;
  headless: boolean;
  setHeadless: (v: boolean) => void;
  keepOpen: boolean;
  setKeepOpen: (v: boolean) => void;
  /** Watch pacing applied to runs (off = full speed). */
  speed: RunSpeed;
  setSpeed: (v: RunSpeed) => void;
}

export function useAutomationRunner(): AutomationRunner {
  const { notify } = useToast();
  const [results, setResults] = useState<ResultMap>({});
  const [running, setRunning] = useState(false);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<AutomationRunRecord | null>(null);
  const [heldOpen, setHeldOpen] = useState(false);
  // Run options persist across reloads (localStorage) — sticky choices, shared
  // with the builder via the same keys.
  const [headless, setHeadless] = usePersistentBoolean("rubato.run.headless", true);
  const [keepOpen, setKeepOpen] = usePersistentBoolean("rubato.run.keepOpen", false);
  const [speed, setSpeed] = usePersistentString<RunSpeed>("rubato.run.speed", "off", RUN_SPEEDS);

  // Don't strand a held-open headed browser if the user navigates away.
  const heldRef = useRef(heldOpen);
  heldRef.current = heldOpen;
  useEffect(
    () => () => {
      if (heldRef.current) void closeAutomationBrowser().catch(() => {});
    },
    [],
  );

  useServerEvent((e) => {
    switch (e.type) {
      case "automation:run:started":
        setResults({});
        setRunning(true);
        setHeldOpen(false);
        setLastRun(null);
        setActiveName(e.automation);
        break;
      case "automation:step":
        setResults((r) => ({ ...r, [e.result.index]: e.result }));
        break;
      case "automation:browser:closed":
        // The held-open headed browser was shut by the user — drop the banner so
        // it doesn't linger offering to close a window that's already gone.
        setHeldOpen(false);
        break;
      case "automation:run:completed": {
        setRunning(false);
        setHeldOpen(!!e.heldOpen);
        setLastRun(e.run);
        if (e.run.status === "failed") {
          const failStep = e.run.steps.find((s) => s.status === "failed");
          notify(failStep ? `Run failed at ${stepLabel(failStep)} — see the run summary` : "Run failed before any step — see the run summary", "error");
        } else {
          notify(`Run passed (${e.run.steps.length} step${e.run.steps.length === 1 ? "" : "s"})`, "success");
        }
        break;
      }
      default:
        break;
    }
  });

  // `urls` (optional) fans across multiple target URLs; `rows` (optional) fans
  // across a matrix of per-run variable sets (one window each). headed + keepOpen
  // leaves them all open.
  const run = async (
    a: Automation,
    variables?: Record<string, string>,
    urls?: string[],
    rows?: Record<string, string>[],
  ) => {
    // Optimistic so the button disables and the panel appears immediately; the
    // started event re-affirms a beat later.
    setActiveName(a.name);
    setLastRun(null);
    setHeldOpen(false);
    setResults({});
    setRunning(true);
    try {
      await runAutomation({ automation: a, headless, keepOpen, speed, variables, urls, rows });
      const fan = rows?.length || urls?.length || 0;
      notify(fan > 1 ? `Running across ${fan}…` : "Run started…");
    } catch (err) {
      setRunning(false);
      notify(err instanceof Error ? err.message : "run failed", "error");
    }
  };

  const closeHeld = async () => {
    await closeAutomationBrowser().catch(() => {});
    setHeldOpen(false);
  };

  return {
    run,
    running,
    activeName,
    results,
    lastRun,
    heldOpen,
    closeHeld,
    headless,
    setHeadless,
    keepOpen,
    setKeepOpen,
    speed,
    setSpeed,
  };
}
