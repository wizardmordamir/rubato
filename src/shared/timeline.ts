/**
 * One timeline model for both worlds you can replay: a recorded **capture**
 * (user-driven session) and a finished automation **run**. Each becomes an ordered
 * list of `Moment`s — a screenshot + HTML + logs + status per step — so a single
 * player UI can step/scrub/auto-play through either. Pure + dependency-free; the
 * URL builders just name existing server routes (capture artifacts / Files raw).
 */

import type { ActionType, AutomationRunRecord, NetworkEntry, StepStatus } from './automation';
import type { CaptureManifest } from './capture';

export interface Moment {
  /** Stable React key. */
  key: string;
  /** Dotted step index ("2.then.0") or capture seq — shown in the rail. */
  index: string;
  /** Short human label, e.g. "click · role=button". */
  label: string;
  /** Run only: how the step ended (captures have no status). */
  status?: StepStatus;
  /** The action, used to pace auto-play (longer after a click/nav). */
  action?: ActionType;
  screenshotUrl?: string;
  htmlUrl?: string;
  logs?: string[];
  scraped?: { name: string; value: string };
  error?: string;
  durationMs?: number;
  /** Page URL at this moment. */
  url?: string;
  /** Page network requests during this step (run moments only). */
  network?: NetworkEntry[];
}

/** Inline-serve URL for a run artifact (output-dir-relative path). */
export const runArtifactUrl = (path: string): string => `/api/files/raw?path=${encodeURIComponent(path)}`;

/** Inline-serve URL for a capture artifact (session-relative path). */
export const captureArtifactUrl = (id: string, path: string): string =>
  `/api/capture/${encodeURIComponent(id)}/artifact?path=${encodeURIComponent(path)}`;

/** A capture session → moments (one per recorded record). */
export function manifestToMoments(manifest: CaptureManifest): Moment[] {
  return (manifest.records ?? []).map((r) => ({
    key: String(r.seq),
    index: String(r.seq),
    label: `${r.kind}${r.action ? ` · ${r.action}` : ''}`,
    action: r.action,
    screenshotUrl: r.screenshotFile ? captureArtifactUrl(manifest.id, r.screenshotFile) : undefined,
    htmlUrl: r.htmlFile ? captureArtifactUrl(manifest.id, r.htmlFile) : undefined,
    url: r.url,
  }));
}

/** A finished run → moments (one per executed step; "running" placeholders dropped). */
export function runToMoments(run: AutomationRunRecord): Moment[] {
  return run.steps
    .filter((s) => s.status !== 'running')
    .map((s) => ({
      key: s.index,
      index: s.index,
      label: `${s.action}${s.selector ? ` · ${s.selector}` : ''}`,
      status: s.status,
      action: s.action === 'if' ? undefined : (s.action as ActionType),
      // Persisted path wins; fall back to an inline data: URL (no output dir).
      screenshotUrl: s.screenshotPath ? runArtifactUrl(s.screenshotPath) : s.screenshot,
      htmlUrl: s.htmlPath ? runArtifactUrl(s.htmlPath) : undefined,
      logs: s.logs,
      scraped: s.scraped,
      error: s.error,
      durationMs: s.durationMs,
      url: s.finalUrl,
      network: s.network,
    }));
}
