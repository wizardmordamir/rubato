import type { AutomationStep, SheetMeta, StepType } from "cwip/excel-engine/types";
import { STEP_TYPE_LABEL, STEP_TYPES } from "cwip/excel-engine/types";
import { createContext, useContext } from "react";

export { STEP_TYPE_LABEL, STEP_TYPES };

export const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

// Sensible defaults per step type (mirrors the server's newStep).
export const newStep = (type: StepType): AutomationStep => {
  const base = { id: uid(), enabled: true };
  switch (type) {
    case "keepSheet":
      return { ...base, type, which: { index: 0 } };
    case "filterRows":
      return { ...base, type, where: { all: [] }, keep: "matching", mode: "hide", hasHeader: true };
    case "limitRows":
      return { ...base, type, count: 100, mode: "delete", hasHeader: true };
    case "renameColumn":
      return { ...base, type, column: {}, to: "" };
    case "sortRows":
      return { ...base, type, by: [{ column: {}, dir: "asc" }], hasHeader: true };
    case "filterColumns":
      return { ...base, type, drop: [], mode: "delete" };
    case "addColumn":
      return { ...base, type, header: "", initialValue: "" };
    case "fillColumn":
      return { ...base, type, target: {}, rules: [], elseValue: "", hasHeader: true };
    case "manualEdit":
      return { ...base, type, sheet: "", edits: [] };
  }
};

// The builder context supplies the ACTIVE revision's columns + sheets, so the
// per-step editors' column pickers reflect the real, current shape of the data.
export interface BuilderContextValue {
  columns: { key: string; title: string }[];
  sheets: SheetMeta[];
}

export const BuilderContext = createContext<BuilderContextValue>({ columns: [], sheets: [] });
export const useBuilder = () => useContext(BuilderContext);
