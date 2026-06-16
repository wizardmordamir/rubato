// Drives the live step-through executor from the builder: start a headed session,
// then Next / Play / Pause / Restart / Stop one action at a time. Per-step results
// arrive on the shared automation:step events (the builder's results map already
// shows them); this hook tracks the cursor + mode off automation:step:state so the
// controls reflect where the run is paused.

import type { Automation, StepRunnerStatus } from "@shared/automation";
import type { RunSpeed } from "@shared/pacing";
import { useEffect, useRef, useState } from "react";
import { stepNext, stepPause, stepPlay, stepRestart, stepStart, stepStop } from "../api";
import { useServerEvent } from "../liveBus";
import { useToast } from "../toast";

export interface StepController {
  active: boolean;
  mode: StepRunnerStatus["mode"];
  cursor: string | null;
  start: (a: Automation, speed: RunSpeed) => Promise<void>;
  next: () => void;
  play: () => void;
  pause: () => void;
  restart: () => void;
  stop: () => void;
}

export function useStepRunner(): StepController {
  const { notify } = useToast();
  const [active, setActive] = useState(false);
  const [mode, setMode] = useState<StepRunnerStatus["mode"]>("idle");
  const [cursor, setCursor] = useState<string | null>(null);
  // Don't strand a headed step browser when the editor unmounts.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(
    () => () => {
      if (activeRef.current) void stepStop().catch(() => {});
    },
    [],
  );

  useServerEvent((e) => {
    if (e.type !== "automation:step:state") return;
    setMode(e.mode);
    setCursor(e.cursor);
    // done = the run finished or the session was stopped → no live session left.
    if (e.done) {
      setActive(false);
      setCursor(null);
    }
  });

  const guard = (fn: () => Promise<unknown>) => () => void fn().catch((err) => notify(String(err), "error"));

  return {
    active,
    mode,
    cursor,
    start: async (a, speed) => {
      try {
        const s = await stepStart({ automation: a, speed });
        setActive(s.active);
        setMode(s.mode);
        setCursor(s.cursor);
        notify("Stepping — Next runs one step.");
      } catch (err) {
        notify(err instanceof Error ? err.message : "step start failed", "error");
      }
    },
    next: guard(stepNext),
    play: guard(stepPlay),
    pause: guard(stepPause),
    restart: guard(stepRestart),
    stop: () => {
      setActive(false);
      void stepStop().catch(() => {});
    },
  };
}
