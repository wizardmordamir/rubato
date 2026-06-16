/**
 * Element-picker integration test. Drives the REAL Node host: arms the picker,
 * then clicks an element through the action protocol — the injected capture-phase
 * listener intercepts it and emits a "picked" target. Verifies the selector
 * heuristic ladder (testid › id › role+name › class) against real DOM.
 *
 * Skips if Chromium isn't installed.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { HostEvent, Target } from '../shared/automation';
import { BrowserHost } from './browserHost';

const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH || resolve(homedir(), 'Library/Caches/ms-playwright');
const hasChromium = existsSync(cacheDir) && readdirSync(cacheDir).some((d) => d.startsWith('chromium'));

const PAGE = `data:text/html,${encodeURIComponent(`
  <html><body>
    <button>Save</button>
    <a href="/next" data-testid="next-link">Next</a>
    <input id="email" placeholder="Email" />
    <div class="uniqcls">hello</div>
  </body></html>`)}`;

const events: HostEvent[] = [];
let host: BrowserHost;

beforeAll(async () => {
  if (!hasChromium) return;
  host = new BrowserHost((e) => events.push(e));
  await host.start();
  await host.launch(true);
  await host.goto(PAGE);
});

afterAll(async () => {
  if (!hasChromium || !host) return;
  await host.close();
  host.kill();
});

/** Arm the picker, click `clickTarget`, return the picked target it produced. */
async function pick(clickTarget: Target): Promise<Target> {
  events.length = 0;
  await host.armPicker();
  await host.exec('click', clickTarget, {});
  // Wait for the binding round-trip.
  const start = Date.now();
  for (;;) {
    const ev = events.find((e) => e.event === 'picked');
    if (ev && ev.event === 'picked') return ev.target;
    if (Date.now() - start > 5000) throw new Error('no picked event');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test.skipIf(!hasChromium)(
  'data-testid wins over href',
  async () => {
    expect(await pick({ kind: 'testid', value: 'next-link' })).toEqual({ kind: 'testid', value: 'next-link' });
  },
  30_000,
);

test.skipIf(!hasChromium)(
  'static id is preferred for the input',
  async () => {
    expect(await pick({ kind: 'id', value: 'email' })).toEqual({ kind: 'id', value: 'email' });
  },
  30_000,
);

test.skipIf(!hasChromium)(
  'button falls back to role + accessible name',
  async () => {
    expect(await pick({ kind: 'role', value: 'button' })).toEqual({ kind: 'role', value: 'button', name: 'Save' });
  },
  30_000,
);

test.skipIf(!hasChromium)(
  'unique class when nothing better exists',
  async () => {
    expect(await pick({ kind: 'class', value: 'uniqcls' })).toEqual({ kind: 'class', value: 'uniqcls' });
  },
  30_000,
);
