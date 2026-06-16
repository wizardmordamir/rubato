// Public barrel for the individual automation-builder components — the
// `rubato/ui/automations/components` lib entry. Where `rubato/ui/automations`
// ships the three whole pages (AutomationsPage / BuilderPage / ViewAutomationPage),
// this ships the building blocks so a friend app can compose its OWN automation
// page — its own layout, toolbar, and surrounding chrome — from parts.
//
// All are prop-driven and safe to render standalone. The step editors reach the
// builder context for live pick/test affordances; without a
// `<BuilderContext.Provider>` ancestor those degrade to no-ops (see `useBuilder`),
// so plain step editing works anywhere. Provide your own `BuilderContext` value to
// wire a live browser session (pick element / test selector).

export { StepList, StepDiagnostics, type ResultMap } from "../../builder/StepList";
export { TimelinePlayer } from "../../builder/TimelinePlayer";
export { RunControls, RunPanel } from "../../builder/RunControls";
export { RunStepLog, RunSummary } from "../../builder/RunSummary";
export { AutomationRunHistory } from "../../builder/AutomationRunHistory";

// Context + model helpers so a consumer can drive live pick/test and build step UIs.
export { ACTIONS, BuilderContext, newStep, stepNeedsTarget, useBuilder } from "../../builder/model";
export type { ActionSpec, BuilderCtx, ParamField } from "../../builder/model";
