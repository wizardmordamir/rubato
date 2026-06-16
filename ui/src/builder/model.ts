/**
 * Shared model bits for the automation builder: the action palette (which params
 * each action exposes), step factories, and the React context the nested step
 * editors use to drive the live browser session (pick / test selectors).
 */

import { createContext, useContext } from "react";
import type { ActionType, LeafAction, Step, StepParams, Target } from "@shared/automation";
import { cloneStep, reorderSteps, uid } from "@shared/stepEdit";

// Step-edit primitives live in the shared layer (browser+server safe, gate-tested);
// re-export so builder code keeps importing them from "./model".
export { cloneStep, reorderSteps, uid };

export type ParamField =
  | "url"
  | "value"
  | "waitKind"
  | "ms"
  | "count"
  | "attr"
  | "regex"
  | "saveAs"
  | "path"
  | "dialogAction";

export interface ActionSpec {
  value: ActionType;
  label: string;
  needsTarget: boolean;
  fields: ParamField[];
}

export const ACTIONS: ActionSpec[] = [
  { value: "goto", label: "Go to URL", needsTarget: false, fields: ["url"] },
  { value: "waitFor", label: "Wait", needsTarget: false, fields: ["waitKind", "ms"] },
  { value: "click", label: "Click", needsTarget: true, fields: [] },
  { value: "hover", label: "Hover", needsTarget: true, fields: [] },
  { value: "fill", label: "Fill", needsTarget: true, fields: ["value"] },
  { value: "select", label: "Select option", needsTarget: true, fields: ["value"] },
  { value: "check", label: "Check", needsTarget: true, fields: [] },
  { value: "uncheck", label: "Uncheck", needsTarget: true, fields: [] },
  { value: "setFiles", label: "Upload file(s)", needsTarget: true, fields: ["value"] },
  { value: "press", label: "Press key", needsTarget: false, fields: ["value"] },
  { value: "dialog", label: "Handle dialog", needsTarget: false, fields: ["dialogAction", "value"] },
  { value: "newTab", label: "Open new tab", needsTarget: false, fields: ["url"] },
  { value: "switchTab", label: "Switch to tab", needsTarget: false, fields: ["count"] },
  { value: "closeTab", label: "Close tab", needsTarget: false, fields: [] },
  { value: "expectText", label: "Expect text", needsTarget: true, fields: ["value"] },
  { value: "expectUrl", label: "Expect URL", needsTarget: false, fields: ["value"] },
  { value: "expectTitle", label: "Expect title", needsTarget: false, fields: ["value"] },
  { value: "expectVisible", label: "Expect visible", needsTarget: true, fields: [] },
  { value: "expectHidden", label: "Expect hidden", needsTarget: true, fields: [] },
  { value: "expectEnabled", label: "Expect enabled", needsTarget: true, fields: [] },
  { value: "expectDisabled", label: "Expect disabled", needsTarget: true, fields: [] },
  { value: "expectValue", label: "Expect value", needsTarget: true, fields: ["value"] },
  { value: "expectAttribute", label: "Expect attribute", needsTarget: true, fields: ["attr", "value"] },
  { value: "expectCount", label: "Expect count", needsTarget: true, fields: ["count"] },
  { value: "scrape", label: "Scrape value", needsTarget: true, fields: ["attr", "regex", "saveAs"] },
  { value: "screenshot", label: "Screenshot", needsTarget: false, fields: [] },
  { value: "snapshot", label: "Snapshot (HTML + image)", needsTarget: false, fields: ["value"] },
  { value: "saveFile", label: "Save to file", needsTarget: false, fields: ["value", "path"] },
  { value: "if", label: "If… (conditional)", needsTarget: false, fields: [] },
];

export const actionSpec = (a: ActionType): ActionSpec => ACTIONS.find((s) => s.value === a) ?? ACTIONS[0];

/** waitFor needs a target only for the visible/hidden kinds. */
export function stepNeedsTarget(step: Step): boolean {
  if (step.action === "waitFor") return step.params?.waitKind === "visible" || step.params?.waitKind === "hidden";
  return actionSpec(step.action).needsTarget;
}

export function newStep(action: ActionType): Step {
  const step: Step = { id: uid(), action };
  if (action === "if") {
    step.condition = { kind: "selector-visible" };
    step.thenSteps = [];
    step.elseSteps = [];
  } else if (action === "waitFor") {
    step.params = { waitKind: "ms", ms: 1000 } as StepParams;
  } else if (action === "goto") {
    step.params = { url: "" };
  }
  return step;
}

export const DEFAULT_TARGET: Target = { kind: "testid", value: "" };

export interface BuilderCtx {
  /** Is a headed browser session live (launched)? */
  launched: boolean;
  /** Is the recorder running? */
  recording: boolean;
  /** Arm a one-shot pick; `apply` receives the chosen target. */
  pickInto: (apply: (t: Target) => void) => void;
  /** Whether a pick is currently armed (so the UI can show "picking…"). */
  picking: boolean;
  /** Run a selector against the live page; returns match count + visibility. */
  test: (t: Target) => Promise<{ matchCount: number; visible: boolean }>;
}

export const BuilderContext = createContext<BuilderCtx | null>(null);

export function useBuilder(): BuilderCtx {
  const ctx = useContext(BuilderContext);
  if (!ctx) throw new Error("useBuilder must be used within the builder");
  return ctx;
}

export const LEAF_ACTIONS = ACTIONS.filter((a) => a.value !== "if").map((a) => a.value as LeafAction);
