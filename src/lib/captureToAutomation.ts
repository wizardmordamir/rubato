/**
 * Turn a recorded capture session into a rerunnable Automation.
 *
 * A capture records every interaction the user performed (each `action` record
 * already carries an automation-shaped action/target/params — it IS the recorder's
 * Step), plus the landed navigations, the initial screen, and any manual snapshots.
 * This lifts those records into an Automation the interpreter can replay.
 *
 * Conversion rules (the "smart" navigation handling):
 *  - `start`  → dropped; the initial load is the automation's `startUrl`.
 *  - `manual` → dropped; a snapshot is an inspection aid, not an action.
 *  - `action` → the step verbatim (click / fill / select / press / …).
 *  - `navigate` → a `goto` step, EXCEPT when it directly follows an `action` (the
 *      nav was that click's side-effect) or the `start` (the initial redirect,
 *      already covered by `startUrl`). A redirect chain can still leave an extra
 *      goto to trim — replay-then-edit, the builder is the source of truth.
 */

import type { Automation, Step } from '../shared/automation';
import type { CaptureManifest, CaptureRecord } from '../shared/capture';
import { insertSmartWaits, type RunSpeed } from '../shared/pacing';
import { cleanCapturedSteps } from './cleanSteps';

/**
 * Build the (unsaved) Automation shape from a capture manifest. With
 * `smartWaits` set (not "off") it bakes watch-pacing `waitFor` steps in, so the
 * generated automation replays slowly enough to follow without further editing.
 */
export function captureToAutomation(
  manifest: CaptureManifest,
  name?: string,
  smartWaits: RunSpeed = 'off',
): Pick<Automation, 'name' | 'description' | 'startUrl' | 'steps'> {
  const records = manifest.records ?? [];
  // Prefer the manifest's start URL (set up front, or adopted from the first real
  // page a blank session landed on). Fall back to a recorded url — but skip the
  // `start` record when it's the headed browser's initial about:blank.
  const startUrl =
    manifest.startUrl ??
    records.find((r) => r.kind === 'navigate' && /^https?:\/\//i.test(r.url))?.url ??
    records.find((r) => r.kind === 'start')?.url ??
    records[0]?.url;

  const steps: Step[] = [];
  let prevKind: CaptureRecord['kind'] | undefined;
  for (const r of records) {
    if (r.kind === 'action' && r.action) {
      steps.push({
        id: `step-${r.seq}`,
        action: r.action,
        ...(r.target ? { target: r.target } : {}),
        ...(r.params ? { params: r.params } : {}),
      });
    } else if (r.kind === 'navigate' && prevKind !== 'action' && prevKind !== 'start') {
      steps.push({ id: `step-${r.seq}`, action: 'goto', params: { url: r.url } });
    }
    prevKind = r.kind;
  }

  // Drop the no-op / duplicate steps a recording leaves behind (empty fills,
  // repeated navigations) so the generated automation actually replays.
  const cleaned = cleanCapturedSteps(steps);

  return {
    name: name?.trim() || manifest.label?.trim() || `capture ${manifest.id}`,
    description: `Generated from capture ${manifest.id}${manifest.label ? ` (${manifest.label})` : ''}.`,
    startUrl,
    steps: smartWaits === 'off' ? cleaned : insertSmartWaits(cleaned, smartWaits),
  };
}
