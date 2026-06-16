/**
 * `rubato/automation` — the public kit for taking a Playwright flow recorded in
 * the rubato UI and dropping it into another app's e2e suite.
 *
 *   import { rebaseAutomationUrls, automationToSpec } from "rubato/automation";
 *
 *   const adapted = rebaseAutomationUrls(recorded, { to: "" });   // make URLs relative
 *   const spec = automationToSpec(adapted, { testModule: "../fixtures" });
 *
 * Two pure layers: `rebaseAutomationUrls` (Automation → Automation, retarget the
 * recorded host) then `automationToSpec` (Automation → `*.spec.ts` source). Both
 * are dependency-free and side-effect-free; the consumer owns the file write.
 */

export type {
  ActionType,
  Automation,
  Condition,
  LeafAction,
  Step,
  StepParams,
  Target,
  TargetKind,
} from '../../shared/automation';
export { automationToSpec, type ExportOptions } from '../exportSpec';
export { type RebaseUrlOptions, rebaseAutomationUrls } from './transform';
