/**
 * Recorder integration test. Arms the recorder, then drives interactions through
 * the action protocol (Playwright dispatches real click/change events, exactly as
 * a user would) and asserts the recorded Steps it synthesizes. Skips without
 * Chromium.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { HostEvent, Step } from '../shared/automation';
import { BrowserHost } from './browserHost';

const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH || resolve(homedir(), 'Library/Caches/ms-playwright');
const hasChromium = existsSync(cacheDir) && readdirSync(cacheDir).some((d) => d.startsWith('chromium'));

const PAGE = `data:text/html,${encodeURIComponent(`
  <html><body>
    <input id="email" placeholder="Email" />
    <select data-testid="env"><option value="dev">dev</option><option value="prod">prod</option></select>
    <input type="checkbox" id="agree" />
    <input type="password" id="pw" placeholder="Password" />
    <div contenteditable="true" id="bio"></div>
    <button>Submit</button>
  </body></html>`)}`;

const PAGE2 = `data:text/html,${encodeURIComponent('<html><body><button>Next</button></body></html>')}`;

const events: HostEvent[] = [];
let host: BrowserHost;

beforeAll(async () => {
  if (!hasChromium) return;
  host = new BrowserHost((e) => events.push(e));
  await host.start();
  await host.launch(true);
  await host.goto(PAGE);
  await host.armRecorder();
});

afterAll(async () => {
  if (!hasChromium || !host) return;
  await host.close();
  host.kill();
});

async function recorded(): Promise<Step[]> {
  // small settle for binding round-trips
  await new Promise((r) => setTimeout(r, 150));
  return events.filter((e) => e.event === 'recorded-step').map((e) => (e as { step: Step }).step);
}

test.skipIf(!hasChromium)(
  'records fill, select, check, and click as steps',
  async () => {
    events.length = 0;
    await host.exec('fill', { kind: 'id', value: 'email' }, { value: 'joe@example.com' });
    await host.exec('select', { kind: 'testid', value: 'env' }, { value: 'prod' });
    await host.exec('check', { kind: 'id', value: 'agree' }, {});
    await host.exec('click', { kind: 'role', value: 'button' }, {});

    const steps = await recorded();
    const byAction = (a: string) => steps.find((s) => s.action === a);

    expect(byAction('fill')).toMatchObject({
      action: 'fill',
      target: { kind: 'id', value: 'email' },
      params: { value: 'joe@example.com' },
    });
    expect(byAction('select')).toMatchObject({
      action: 'select',
      target: { kind: 'testid', value: 'env' },
      params: { value: 'prod' },
    });
    expect(byAction('check')).toMatchObject({ action: 'check', target: { kind: 'id', value: 'agree' } });
    expect(byAction('click')).toMatchObject({
      action: 'click',
      target: { kind: 'role', value: 'button', name: 'Submit' },
    });
    // checkbox click must NOT also be recorded as a click step
    expect(steps.filter((s) => s.action === 'click')).toHaveLength(1);
  },
  30_000,
);

test.skipIf(!hasChromium)(
  'records Enter in a field as a fill then a press',
  async () => {
    events.length = 0;
    await host.exec('fill', { kind: 'id', value: 'email' }, { value: 'search term' });
    await host.exec('press', { kind: 'id', value: 'email' }, { value: 'Enter' });

    const steps = await recorded();
    // The committed value is flushed once (not double-recorded by the change event)…
    const fills = steps.filter((s) => s.action === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ target: { kind: 'id', value: 'email' }, params: { value: 'search term' } });
    // …followed by the Enter press, in that order.
    expect(steps.map((s) => s.action)).toEqual(['fill', 'press']);
    expect(steps[1]).toMatchObject({
      action: 'press',
      target: { kind: 'id', value: 'email' },
      params: { value: 'Enter' },
    });
  },
  30_000,
);

test.skipIf(!hasChromium)(
  'records contenteditable text as a fill, flushed by a following click',
  async () => {
    events.length = 0;
    // A contenteditable host fires `input` but never `change`, so the fill is
    // captured when the edit ends — here the click that follows it.
    await host.exec('fill', { kind: 'id', value: 'bio' }, { value: 'hello world' });
    await host.exec('click', { kind: 'role', value: 'button' }, {});

    const steps = await recorded();
    expect(steps.map((s) => s.action)).toEqual(['fill', 'click']);
    expect(steps[0]).toMatchObject({ target: { kind: 'id', value: 'bio' }, params: { value: 'hello world' } });
  },
  30_000,
);

test.skipIf(!hasChromium)(
  "captures a password's value but flags it secret",
  async () => {
    events.length = 0;
    await host.exec('fill', { kind: 'id', value: 'pw' }, { value: 'hunter2' });
    await host.exec('click', { kind: 'role', value: 'button' }, {});

    const steps = await recorded();
    const fill = steps.find((s) => s.action === 'fill' && s.target?.value === 'pw');
    // The typed characters are captured (so the automation is faithful/replayable),
    // and marked secret so the builder masks them behind the eye toggle.
    expect(fill).toMatchObject({ params: { value: 'hunter2', valueMode: 'secret' } });
  },
  30_000,
);

test.skipIf(!hasChromium)(
  'records a modifier shortcut as a press combo',
  async () => {
    events.length = 0;
    await host.exec('press', { kind: 'id', value: 'email' }, { value: 'Control+s' });

    const steps = await recorded();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ action: 'press', params: { value: 'Control+s' } });
  },
  30_000,
);

test.skipIf(!hasChromium)(
  'records navigation keys outside a text field, but leaves them to the fill inside one',
  async () => {
    events.length = 0;
    await host.exec('press', { kind: 'role', value: 'button' }, { value: 'ArrowDown' });
    await host.exec('press', { kind: 'id', value: 'email' }, { value: 'ArrowLeft' });

    const steps = await recorded();
    // ArrowDown driving the button (a widget key outside a text field) is recorded…
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action: 'press',
      target: { kind: 'role', value: 'button' },
      params: { value: 'ArrowDown' },
    });
    // …ArrowLeft inside the input is just editing — the fill captures the result.
  },
  30_000,
);

test.skipIf(!hasChromium)(
  'keeps recording after a navigation (mode survives a fresh document)',
  async () => {
    events.length = 0;
    await host.goto(PAGE2);
    // A fresh document resets __rubatoMode to "idle"; the host must re-apply the
    // recorder mode or every interaction on page 2+ would go unrecorded.
    await new Promise((r) => setTimeout(r, 200));
    await host.exec('click', { kind: 'role', value: 'button' }, {});

    const steps = await recorded();
    expect(steps.some((s) => s.action === 'click' && s.target?.name === 'Next')).toBe(true);
  },
  30_000,
);
