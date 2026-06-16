/**
 * Pure helpers for capture bundles — the single, shippable artifact of a
 * data-gathering session. A bundle is the manifest plus every HTML/screenshot
 * inlined, gzipped to one file you can move between machines; parse it on the
 * other side to inspect screens/actions and mine selectors. No fs/Playwright here
 * (so it unit-tests cleanly); the session/store layer owns disk I/O.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { openFromText, sealToText } from 'cwip/node';
import type { Step } from '../shared/automation';
import type { CaptureBundle, CaptureManifest, CaptureRecord, CaptureSummary } from '../shared/capture';
import { cleanCapturedSteps } from './cleanSteps';

export function summarizeManifest(m: CaptureManifest): CaptureSummary {
  return {
    id: m.id,
    label: m.label,
    note: m.note,
    startedAt: m.startedAt,
    stoppedAt: m.stoppedAt,
    count: m.records.length,
  };
}

/** Assemble a v1 bundle from a manifest + its inlined artifacts (path → content). */
export function buildBundle(manifest: CaptureManifest, artifacts: Record<string, string>): CaptureBundle {
  return { version: 1, manifest, artifacts };
}

/** Serialize a bundle to gzipped JSON bytes (the on-the-wire / on-disk form). */
export function serializeBundle(bundle: CaptureBundle): Uint8Array {
  return gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'));
}

/** Validate a parsed bundle object (shared by the gzip + text decoders). */
function validateBundle(json: unknown): CaptureBundle {
  const b = json as Partial<CaptureBundle>;
  if (!b || b.version !== 1 || !b.manifest || !Array.isArray(b.manifest.records) || typeof b.artifacts !== 'object') {
    throw new Error('unrecognized capture bundle (expected version 1 with a manifest + artifacts)');
  }
  return b as CaptureBundle;
}

/** Parse + validate gzipped bundle bytes. Throws an actionable error on bad input. */
export function parseBundle(bytes: Uint8Array): CaptureBundle {
  let text: string;
  try {
    text = gunzipSync(Buffer.from(bytes)).toString('utf8');
  } catch {
    throw new Error("not a capture bundle: input isn't gzip-compressed");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("not a capture bundle: decompressed content isn't JSON");
  }
  return validateBundle(json);
}

/**
 * Encode a bundle as a single compact, shareable STRING (paste into email/chat).
 * With a `seed` it's AES-256-GCM encrypted (an `rbz1_…` token requiring the seed to
 * open); without one it's Brotli-compressed only (`rbp1_…`, compact but not secret).
 * Both via cwip `sealToText` (compress-then-encrypt → base64url).
 */
export function bundleToText(bundle: CaptureBundle, seed?: string): string {
  return sealToText(JSON.stringify(bundle), seed);
}

/** Decode a bundle string produced by `bundleToText`. A sealed token needs its seed. */
export function bundleFromText(token: string, seed?: string): CaptureBundle {
  const json = JSON.parse(openFromText(token.trim(), seed));
  return validateBundle(json);
}

/**
 * Convert a session's recorded `action` moments into automation steps — so a
 * gathered session can seed a real Automation. Navigate/start/manual frames (no
 * interaction) are skipped; only entries with an action + target become steps.
 */
export function captureRecordsToSteps(records: CaptureRecord[]): Step[] {
  const steps: Step[] = [];
  for (const r of records) {
    if (r.kind !== 'action' || !r.action || !r.target) continue;
    steps.push({
      id: `cap-${steps.length + 1}`,
      action: r.action,
      target: r.target,
      params: r.params,
      note: `captured @ ${r.url}`,
    });
  }
  // Strip the no-op / duplicate steps a recording leaves behind so the seeded
  // automation replays (same cleanup as captureToAutomation).
  return cleanCapturedSteps(steps);
}
