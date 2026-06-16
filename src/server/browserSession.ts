/**
 * The single long-lived *headed* browser the Browser builder UI drives while you
 * author a flow: launch at a URL, test/highlight selectors, pick elements, record
 * interactions into editable steps and — when "Capture screens" is on — bundle
 * each moment's page HTML + a screenshot into a persisted, exportable capture
 * session (see lib/captureStore). One global session (this is a loopback personal
 * tool — no need for multi-session). Host events are bridged onto the same /ws
 * event bus the rest of the UI already listens to.
 *
 * Recording and capturing share one BrowserHost: the Node host emits a
 * `recorded-step` (→ editable step) and, while capturing, also a `capture-event`
 * (→ persisted artifact) for the same interaction. Capture builds on the recorder,
 * so it can be toggled on/off mid-session without dropping the recorder.
 *
 * Headless *runs* don't use this — engine.ts spawns its own throwaway host so a
 * run never disturbs the build session.
 */

import { type CaptureStore, captureStore as defaultCaptureStore } from '../lib/captureStore';
import { normalizeUrl } from '../lib/url';
import type { HostEvent, SessionStatus, Target } from '../shared/automation';
import type { CaptureManifest } from '../shared/capture';
import { BrowserHost } from './browserHost';
import { emit } from './events';

// The capture backend for this session's persisted moments. Defaults to rubato's
// file store; a friend app points it at its own via `setSessionCaptureStore` (the
// automations plugin does this when given a `captureStore`). One session, so a
// module-level store is fine.
let captures: CaptureStore = defaultCaptureStore;

/** Point the live build session's capture writes at a custom {@link CaptureStore}. */
export function setSessionCaptureStore(store: CaptureStore): void {
  captures = store;
}

let session: BrowserHost | null = null;
// The capture track for the current session, created lazily the first time capture
// is turned on and finalized when the session closes. Null = capturing has never
// been enabled this session.
let manifest: CaptureManifest | null = null;
let recording = false;
let capturing = false;
// Serialize capture persistence so records keep their order and file writes don't race.
let chain: Promise<void> = Promise.resolve();

/** A real, navigable destination — not the headed browser's initial about:blank. */
function isRealUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function bridge(e: HostEvent): void {
  switch (e.event) {
    case 'picked':
      emit({ type: 'session:picked', target: e.target, selector: e.selector });
      break;
    case 'recorded-step':
      emit({ type: 'session:recorded-step', step: e.step });
      break;
    case 'navigated':
      emit({ type: 'session:navigated', url: e.url });
      // Capture started blank: adopt the first real page the user lands on as the
      // capture track's start URL.
      if (manifest && !manifest.startUrl && isRealUrl(e.url)) {
        manifest.startUrl = e.url;
        void captures.writeManifest(manifest).catch(() => {});
      }
      break;
    case 'capture-event': {
      if (!manifest) break;
      const m = manifest;
      // Persist each moment as it arrives (bounded memory; survives a crash).
      chain = chain.then(async () => {
        const rec = await captures.persistMoment(m.id, e.entry, e.html, e.screenshot).catch(() => null);
        if (!rec) return;
        m.records.push(rec);
        await captures.writeManifest(m).catch(() => {});
        emit({ type: 'session:captured', id: m.id, count: m.records.length, kind: rec.kind, url: rec.url });
      });
      break;
    }
    case 'closed':
      recording = false;
      capturing = false;
      void finalizeManifest();
      emit({ type: 'session:closed' });
      break;
    default:
      break;
  }
}

async function ensure(): Promise<BrowserHost> {
  if (session) return session;
  const host = new BrowserHost(bridge);
  await host.start();
  session = host;
  return host;
}

/** Stamp the capture track's stop time and flush the last write (idempotent). */
async function finalizeManifest(): Promise<void> {
  await chain.catch(() => {});
  if (manifest && !manifest.stoppedAt) {
    manifest.stoppedAt = Date.now();
    await captures.writeManifest(manifest).catch(() => {});
  }
}

/** Launch (or relaunch) the headed browser at a URL. */
export async function launchSession(url: string, headless = false): Promise<void> {
  const host = await ensure();
  await host.launch(headless, normalizeUrl(url));
}

export async function sessionGoto(url: string): Promise<void> {
  await ensure().then((h) => h.goto(normalizeUrl(url)));
}

export async function sessionTestSelector(target: Target): Promise<{ matchCount: number; visible: boolean }> {
  const host = await ensure();
  return host.testSelector(target);
}

export async function sessionHighlight(target: Target): Promise<void> {
  await ensure().then((h) => h.highlight(target));
}

export async function sessionSetPicker(on: boolean): Promise<void> {
  const host = await ensure();
  await (on ? host.armPicker() : host.stopMode());
}

export async function sessionSetRecorder(on: boolean): Promise<void> {
  const host = await ensure();
  await (on ? host.armRecorder() : host.stopMode());
  recording = on;
  // Stopping the recorder (stop-mode) also stops capture in the host — keep the
  // server flag in step so status reflects reality.
  if (!on) capturing = false;
}

/**
 * Toggle artifact capture (HTML + screenshot per moment) on/off without stopping
 * the recorder. Turning it on the first time creates the capture track; capture
 * implies recording, so this also arms the recorder. Returns the live status.
 */
export async function sessionSetCapture(on: boolean): Promise<SessionStatus> {
  const host = await ensure();
  if (on && !manifest) {
    const current = await host.currentUrl().catch(() => '');
    manifest = {
      id: `cap-${Date.now()}`,
      startUrl: isRealUrl(current) ? current : undefined,
      startedAt: Date.now(),
      records: [],
    };
    await captures.writeManifest(manifest);
  }
  await host.setCapture(on); // on → also ensures recording mode in the host
  capturing = on;
  if (on) recording = true;
  return status();
}

/** Bundle the current screen on demand (a manual "snapshot now" while capturing). */
export async function sessionSnapshot(): Promise<SessionStatus> {
  if (session && capturing) await session.captureFrame().catch(() => {});
  return status();
}

export async function sessionUrl(): Promise<string> {
  if (!session) return '';
  return session.currentUrl();
}

export function sessionActive(): boolean {
  return session != null;
}

function status(): SessionStatus {
  return {
    active: session != null,
    url: manifest?.startUrl ?? '',
    recording,
    capturing,
    captureId: manifest?.id,
    captureCount: manifest?.records.length ?? 0,
  };
}

/** Live session status for the builder to hydrate its toolbar on mount/reload. */
export async function sessionStatus(): Promise<SessionStatus> {
  const url = session ? await session.currentUrl().catch(() => '') : '';
  return { ...status(), url: url || (manifest?.startUrl ?? '') };
}

/** Close the browser and tear down the host (finalizing the capture track first). */
export async function closeSession(): Promise<void> {
  if (!session) return;
  const host = session;
  session = null;
  recording = false;
  capturing = false;
  await finalizeManifest();
  manifest = null;
  await host.close().catch(() => {});
  host.kill();
  emit({ type: 'session:closed' });
}

// Never leak the headed Chromium if the server is killed.
function killOnExit(): void {
  session?.kill();
}
process.on('exit', killOnExit);
process.on('SIGINT', () => {
  killOnExit();
  process.exit(0);
});
process.on('SIGTERM', () => {
  killOnExit();
  process.exit(0);
});
