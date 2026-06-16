/**
 * Wire types for the capture / data-gathering recorder: a user drives a real
 * (headed) browser and rubato records each interaction + the page HTML + a
 * screenshot into a persisted session, exportable as one shippable bundle. On
 * another machine the bundle is imported and inspected to learn the exact screens,
 * markup (→ selectors), and actions. Pure types only (shared with the UI via @shared).
 */

import type { LeafAction, StepParams, Target } from './automation';

export type CaptureEntryKind =
  | 'start' // the initial screen when capture began
  | 'navigate' // a landed navigation
  | 'action' // a recorded interaction (click / fill / select / …)
  | 'manual'; // a user-triggered "snapshot now"

/** One recorded moment (metadata only; HTML + screenshot live as separate artifacts). */
export interface CaptureEntry {
  seq: number;
  ts: number;
  url: string;
  kind: CaptureEntryKind;
  /** For `action` entries: the interaction the user performed. */
  action?: LeafAction;
  target?: Target;
  params?: StepParams;
}

/** A capture entry annotated with the relative paths of its persisted artifacts. */
export interface CaptureRecord extends CaptureEntry {
  /** Relative path (within the session/bundle) to the saved HTML. */
  htmlFile?: string;
  /** Relative path to the saved screenshot. */
  screenshotFile?: string;
}

export interface CaptureManifest {
  id: string;
  /** Optional human label, e.g. "jenkins deploy screens". */
  label?: string;
  /**
   * Optional free-text description — explain the session's purpose more fully
   * than the label can (what it captures, which environment/machine, why it
   * matters). Settable at start and editable afterward on a stored session.
   */
  note?: string;
  /**
   * Where the session began. Set from the Start URL when given; when capture is
   * started blank, adopted from the first real page the user navigates to (so the
   * recording — and the automation generated from it — still has a starting point).
   */
  startUrl?: string;
  startedAt: number;
  stoppedAt?: number;
  records: CaptureRecord[];
}

/**
 * A single-file, shippable bundle: the manifest plus every artifact inlined
 * (HTML as text, screenshots as `data:` URLs), keyed by the record's relative
 * file path. Serialized + gzipped for transport (see lib/captureBundle).
 */
export interface CaptureBundle {
  /** Bundle format version, so an importer can adapt. */
  version: 1;
  manifest: CaptureManifest;
  artifacts: Record<string, string>;
}

/** A stored (or imported) bundle, as listed in the UI. */
export interface CaptureSummary {
  id: string;
  label?: string;
  note?: string;
  startedAt: number;
  stoppedAt?: number;
  count: number;
}
