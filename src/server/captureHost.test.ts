/**
 * Capture-mode host integration: arms capture, drives a real interaction through
 * the action protocol, and asserts the host emits `capture-event`s carrying the
 * page HTML + a screenshot (the per-moment bundle data). Uses whichever browser
 * the host would (system Chrome preferred, bundled Chromium otherwise); skips when
 * neither is available so the gate stays browser-free on bare machines.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { HostEvent } from '../shared/automation';
import { BrowserHost } from './browserHost';

const chromiumCache = process.env.PLAYWRIGHT_BROWSERS_PATH || resolve(homedir(), 'Library/Caches/ms-playwright');
const hasChromium = existsSync(chromiumCache) && readdirSync(chromiumCache).some((d) => d.startsWith('chromium'));
const hasChrome =
  !!Bun.which('google-chrome') ||
  !!Bun.which('google-chrome-stable') ||
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const hasBrowser = hasChromium || hasChrome;

const PAGE = `data:text/html,${encodeURIComponent(`
  <html><body>
    <h1>Deploy</h1>
    <input id="version" placeholder="Version" />
    <div contenteditable="true" id="notes"></div>
    <button>Build</button>
  </body></html>`)}`;

const events: HostEvent[] = [];
let host: BrowserHost;

beforeAll(async () => {
  if (!hasBrowser) return;
  host = new BrowserHost((e) => events.push(e));
  await host.start();
  await host.launch(true); // headless is fine — capture instrumentation is the same
  await host.goto(PAGE);
  await host.armCapture();
});

afterAll(async () => {
  if (!hasBrowser || !host) return;
  await host.close();
  host.kill();
});

function captureEvents(): Array<Extract<HostEvent, { event: 'capture-event' }>> {
  return events.filter((e) => e.event === 'capture-event') as Array<Extract<HostEvent, { event: 'capture-event' }>>;
}

test.skipIf(!hasBrowser)(
  'arm-capture bundles the initial screen, and a recorded action carries HTML + a screenshot',
  async () => {
    // The arm-capture handler emits a "start" frame; give the binding a beat.
    await new Promise((r) => setTimeout(r, 250));
    const start = captureEvents().find((e) => e.entry.kind === 'start');
    expect(start).toBeTruthy();
    expect(start?.html).toContain('Deploy');
    expect(start?.screenshot).toMatch(/^data:image\/jpeg;base64,/);

    // Drive a fill then a click — the click blurs the input (committing the fill's
    // change → a recorded step) and is itself recorded. Capture mode bundles the
    // page HTML + screenshot alongside each.
    await host.exec('fill', { kind: 'id', value: 'version' }, { value: '1.2.3' });
    await host.exec('click', { kind: 'role', value: 'button' }, {});
    await new Promise((r) => setTimeout(r, 400));

    const actions = captureEvents().filter((e) => e.entry.kind === 'action');
    expect(actions.length).toBeGreaterThan(0);
    const fill = actions.find((e) => e.entry.action === 'fill');
    expect(fill).toBeTruthy();
    expect(fill?.entry.target).toMatchObject({ kind: 'id', value: 'version' });
    // Every captured action carries the page HTML + a screenshot.
    for (const a of actions) {
      expect(a.html).toContain('version');
      expect(a.screenshot).toMatch(/^data:image\/jpeg;base64,/);
    }
  },
  30_000,
);

test.skipIf(!hasBrowser)(
  'captures a field still being edited when capture stops',
  async () => {
    // Type into a contenteditable (fires `input`, never `change`) and DON'T blur
    // it — the rubato Stop button lives in another window, so a focused field
    // never blurs. The host must drain the pending edit at stop and capture a
    // final action frame for it, or the typed text would be lost.
    await host.exec('fill', { kind: 'id', value: 'notes' }, { value: 'draft text' });
    await host.stopMode();
    await new Promise((r) => setTimeout(r, 400));

    const draft = captureEvents().find(
      (e) => e.entry.kind === 'action' && e.entry.action === 'fill' && e.entry.params?.value === 'draft text',
    );
    expect(draft).toBeTruthy();
    expect(draft?.entry.target).toMatchObject({ kind: 'id', value: 'notes' });
    expect(draft?.html).toContain('notes');
  },
  30_000,
);
