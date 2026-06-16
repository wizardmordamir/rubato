/**
 * Integration test: drives the REAL Node Playwright host headless through the
 * shared interpreter against a known HTML page. Proves the whole stack — stdio
 * protocol, resolveLocator, action execution, scrape bag — end to end.
 *
 * Skips automatically if Chromium isn't installed (bunx playwright install chromium).
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { runAutomation } from '../lib/interpreter';
import type { Automation, StepResult } from '../shared/automation';
import { BrowserHost } from './browserHost';

const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH || resolve(homedir(), 'Library/Caches/ms-playwright');
const hasChromium = existsSync(cacheDir) && readdirSync(cacheDir).some((d) => d.startsWith('chromium'));
const hasNode = !!Bun.which('node');

const PAGE = `data:text/html,${encodeURIComponent(`
  <html><body>
    <h1 data-testid="title">Acme Corp</h1>
    <a href="/next" data-testid="next">Next</a>
    <input id="q" placeholder="search" />
    <button>Save</button>
  </body></html>`)}`;

let host: BrowserHost;

beforeAll(async () => {
  if (!hasChromium) return;
  host = new BrowserHost();
  await host.start();
  await host.launch(true);
});

afterAll(async () => {
  if (!hasChromium || !host) return;
  await host.close();
  host.kill();
});

test.skipIf(!hasChromium)(
  'runs a real automation: goto, scrape, fill, expect, click',
  async () => {
    const automation: Automation = {
      id: 'it',
      name: 'it',
      startUrl: PAGE,
      createdAt: 0,
      updatedAt: 0,
      steps: [
        { id: '1', action: 'expectVisible', target: { kind: 'testid', value: 'title' } },
        { id: '2', action: 'scrape', target: { kind: 'testid', value: 'title' }, params: { saveAs: 'company' } },
        { id: '3', action: 'fill', target: { kind: 'id', value: 'q' }, params: { value: 'hello' } },
        {
          id: '4',
          action: 'expectText',
          target: { kind: 'role', value: 'button', name: 'Save' },
          params: { value: 'Save' },
        },
        {
          id: '5',
          action: 'scrape',
          target: { kind: 'testid', value: 'next' },
          params: { attr: 'href', saveAs: 'link' },
        },
      ],
    };

    const events: StepResult[] = [];
    const out = await runAutomation(host, automation, {
      scraped: {},
      emit: (r) => events.push(r),
    });

    expect(out.status).toBe('passed');
    expect(out.scraped.company).toBe('Acme Corp');
    expect(out.scraped.link).toBe('/next');
    expect(out.steps.every((s) => s.status === 'passed')).toBe(true);
    // a "running" event was emitted for at least one step before its result
    expect(events.some((e) => e.status === 'running')).toBe(true);
  },
  30_000,
);

// When the Node host dies (e.g. the user closes a headed browser and it takes the
// process down), in-flight and subsequent commands must reject — never hang. A
// hung command would leave a run awaiting forever, so the UI never leaves "Running…".
test.skipIf(!hasNode)(
  'an in-flight command rejects when the host process is killed',
  async () => {
    const h = new BrowserHost();
    await h.start();
    // `url` before a page exists keeps the host busy enough; kill before it answers.
    const inflight = h.currentUrl();
    h.kill();
    await expect(inflight).rejects.toThrow(/host exited|page/i);
  },
  10_000,
);

test.skipIf(!hasNode)(
  'commands issued after the host has exited reject immediately',
  async () => {
    const h = new BrowserHost();
    await h.start();
    expect(h.alive).toBe(true);
    h.kill();
    // Let the exit handler run.
    await Bun.sleep(50);
    expect(h.alive).toBe(false);
    await expect(h.currentUrl()).rejects.toThrow(/host exited/i);
  },
  10_000,
);

test.skipIf(!hasChromium)(
  'exec with capture returns a per-step frame (HTML + screenshot); without it, none',
  async () => {
    await host.goto(PAGE);
    const captured = await host.exec('click', { kind: 'role', value: 'button', name: 'Save' }, {}, undefined, true);
    expect(captured.html).toContain('Acme Corp');
    expect(captured.screenshot).toMatch(/^data:image\/jpeg;base64,/);

    await host.goto(PAGE);
    const plain = await host.exec('click', { kind: 'role', value: 'button', name: 'Save' }, {}, undefined, false);
    expect(plain.html).toBeUndefined();
    expect(plain.screenshot).toBeUndefined();
  },
  30_000,
);

test.skipIf(!hasChromium)(
  'test-selector reports match count + visibility',
  async () => {
    await host.goto(PAGE);
    const hit = await host.testSelector({ kind: 'testid', value: 'title' });
    expect(hit.matchCount).toBe(1);
    expect(hit.visible).toBe(true);
    const miss = await host.testSelector({ kind: 'testid', value: 'nope' });
    expect(miss.matchCount).toBe(0);
  },
  30_000,
);
