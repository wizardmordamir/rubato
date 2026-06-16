import { afterEach, expect, test } from 'bun:test';
import type {
  ActionOutcome,
  Automation,
  Condition,
  LeafAction,
  StepParams,
  StepResult,
  Target,
} from '../shared/automation';
import {
  actionNeedsTarget,
  type BrowserDriver,
  describeActionFailure,
  extractWithRegex,
  runAutomation,
} from './interpreter';

interface Call {
  action: LeafAction;
  target?: Target;
  params: StepParams;
}

/** A fake driver: records calls, returns canned outcomes, scriptable failures. */
class FakeDriver implements BrowserDriver {
  calls: Call[] = [];
  conditionResult = true;
  // action → outcome, or a thrown error
  outcomes: Partial<Record<LeafAction, ActionOutcome | Error>> = {};

  async exec(action: LeafAction, target: Target | undefined, params: StepParams): Promise<ActionOutcome> {
    this.calls.push({ action, target, params });
    const o = this.outcomes[action];
    if (o instanceof Error) throw o;
    return o ?? {};
  }
  async condition(_c: Condition): Promise<boolean> {
    return this.conditionResult;
  }
}

function automation(steps: Automation['steps'], extra: Partial<Automation> = {}): Automation {
  return { id: 't', name: 't', steps, createdAt: 0, updatedAt: 0, ...extra };
}

function collect() {
  const events: StepResult[] = [];
  return { events, emit: (r: StepResult) => events.push(r), scraped: {} as Record<string, string> };
}

afterEach(() => {
  delete process.env.RUBATO_TEST_PW;
});

test('runs startUrl then steps, passes', async () => {
  const d = new FakeDriver();
  const c = collect();
  const out = await runAutomation(
    d,
    automation([{ id: 'a', action: 'click', target: { kind: 'testid', value: 'go' } }], { startUrl: 'http://x' }),
    c,
  );
  expect(out.status).toBe('passed');
  expect(d.calls[0]).toMatchObject({ action: 'goto', params: { url: 'http://x' } });
  expect(d.calls[1]).toMatchObject({ action: 'click' });
});

test('scrape stores into the bag and into later interpolation', async () => {
  const d = new FakeDriver();
  d.outcomes.scrape = { value: 'Acme Corp' };
  const c = collect();
  const out = await runAutomation(
    d,
    automation([
      { id: 's', action: 'scrape', target: { kind: 'css', value: 'h1' }, params: { saveAs: 'title' } },
      { id: 'f', action: 'fill', target: { kind: 'id', value: 'q' }, params: { value: 'got ${scraped.title}' } },
    ]),
    c,
  );
  expect(out.status).toBe('passed');
  expect(out.scraped.title).toBe('Acme Corp');
  expect(d.calls[1].params.value).toBe('got Acme Corp');
});

test('if/then vs else branch', async () => {
  const d = new FakeDriver();
  d.conditionResult = false;
  const c = collect();
  await runAutomation(
    d,
    automation([
      {
        id: 'if',
        action: 'if',
        condition: { kind: 'url-matches', value: '/login' },
        thenSteps: [{ id: 't', action: 'click', target: { kind: 'testid', value: 'in-then' } }],
        elseSteps: [{ id: 'e', action: 'click', target: { kind: 'testid', value: 'in-else' } }],
      },
    ]),
    c,
  );
  expect(d.calls).toHaveLength(1);
  expect(d.calls[0].target?.value).toBe('in-else');
});

test('optional failure is skipped and the run continues', async () => {
  const d = new FakeDriver();
  d.outcomes.click = new Error('boom');
  const c = collect();
  const out = await runAutomation(
    d,
    automation([
      { id: 'a', action: 'click', target: { kind: 'testid', value: 'x' }, options: { optional: true } },
      { id: 'b', action: 'fill', target: { kind: 'id', value: 'y' }, params: { value: 'z' } },
    ]),
    c,
  );
  expect(out.status).toBe('passed');
  const skipped = out.steps.find((s) => s.stepId === 'a');
  expect(skipped?.status).toBe('skipped');
  expect(d.calls.some((cl) => cl.action === 'fill')).toBe(true);
});

test('required failure stops the run and reports failed', async () => {
  const d = new FakeDriver();
  d.outcomes.click = new Error('boom');
  const c = collect();
  const out = await runAutomation(
    d,
    automation([
      { id: 'a', action: 'click', target: { kind: 'testid', value: 'x' } },
      { id: 'b', action: 'fill', target: { kind: 'id', value: 'y' }, params: { value: 'z' } },
    ]),
    c,
  );
  expect(out.status).toBe('failed');
  expect(d.calls.some((cl) => cl.action === 'fill')).toBe(false);
});

test('secret values are redacted out of error messages', async () => {
  process.env.RUBATO_TEST_PW = 'hunter2';
  const d = new FakeDriver();
  d.outcomes.fill = new Error('could not fill with value hunter2');
  const c = collect();
  const out = await runAutomation(
    d,
    automation([
      { id: 'a', action: 'fill', target: { kind: 'id', value: 'pw' }, params: { value: '${RUBATO_TEST_PW}' } },
    ]),
    c,
  );
  const step = out.steps[0];
  expect(step.status).toBe('failed');
  expect(step.error).not.toContain('hunter2');
  expect(step.error).toContain('***');
  // and the real value did reach the driver
  expect(d.calls[0].params.value).toBe('hunter2');
});

test("valueMode 'env' resolves the value from an env-var NAME and redacts it", async () => {
  process.env.RUBATO_TEST_PW = 'hunter2';
  const d = new FakeDriver();
  d.outcomes.fill = new Error('could not fill with value hunter2');
  const c = collect();
  const out = await runAutomation(
    d,
    automation([
      // value is the bare var name, not ${...}
      {
        id: 'a',
        action: 'fill',
        target: { kind: 'id', value: 'pw' },
        params: { value: 'RUBATO_TEST_PW', valueMode: 'env' },
      },
    ]),
    c,
  );
  // the real secret reached the driver, but never the error
  expect(d.calls[0].params.value).toBe('hunter2');
  expect(out.steps[0].error).not.toContain('hunter2');
  expect(out.steps[0].error).toContain('***');
});

test('a target-needing step with NO target fails clearly (and never reaches the host)', async () => {
  const d = new FakeDriver();
  const c = collect();
  const out = await runAutomation(
    d,
    // a fill with no `target` — the "captured step lost its element" case
    automation([{ id: 'a', action: 'fill', params: { value: 'hello' } }]),
    c,
  );
  expect(out.status).toBe('failed');
  const step = out.steps[0];
  expect(step.status).toBe('failed');
  expect(step.error).toContain('no target element');
  expect(step.error).toContain('pick the element');
  // it short-circuited — the host was never asked to act on a missing element
  expect(d.calls).toHaveLength(0);
});

test('an OPTIONAL target-needing step with no target is skipped, not failed', async () => {
  const d = new FakeDriver();
  const c = collect();
  const out = await runAutomation(
    d,
    automation([
      { id: 'a', action: 'click', options: { optional: true } },
      { id: 'b', action: 'goto', params: { url: 'http://x' } },
    ]),
    c,
  );
  expect(out.status).toBe('passed');
  expect(out.steps[0].status).toBe('skipped');
  expect(d.calls.some((cl) => cl.action === 'goto')).toBe(true);
});

test('a locator timeout is reworded into a clear "could not find the element" message', async () => {
  const d = new FakeDriver();
  d.outcomes.fill = new Error("locator.fill: Timeout 15000ms exceeded.\nCall log: waiting for locator('#email')");
  const c = collect();
  const out = await runAutomation(
    d,
    automation([{ id: 'a', action: 'fill', target: { kind: 'id', value: 'email' }, params: { value: 'a@b.c' } }]),
    c,
  );
  const step = out.steps[0];
  expect(step.status).toBe('failed');
  expect(step.error).toContain('Could not find the element to fill');
  expect(step.error).toContain('#email'); // names the selector
  expect(step.error).toContain('Re-pick the element'); // actionable guidance
  expect(step.error).toContain('Details:'); // keeps the raw error for debugging
});

test('a non-element error (and non-element actions) pass through unchanged', () => {
  // goto navigation timeout: no selector → not reworded
  expect(describeActionFailure('goto', undefined, 'Timeout 30000ms exceeded', 30000)).toBe('Timeout 30000ms exceeded');
  // an element action with a non-locator error → unchanged
  expect(describeActionFailure('fill', '#x', 'some unrelated error')).toBe('some unrelated error');
});

test('actionNeedsTarget: element actions need one, page-level ones do not', () => {
  for (const a of ['fill', 'click', 'scrape', 'expectVisible', 'expectValue'] as const) {
    expect(actionNeedsTarget(a)).toBe(true);
  }
  for (const a of ['goto', 'newTab', 'snapshot', 'saveFile', 'press', 'expectUrl'] as const) {
    expect(actionNeedsTarget(a)).toBe(false);
  }
  // waitFor only for element-state waits
  expect(actionNeedsTarget('waitFor', { waitKind: 'visible' })).toBe(true);
  expect(actionNeedsTarget('waitFor', { waitKind: 'networkidle' })).toBe(false);
});

test("valueMode 'secret' keeps a literal value out of error messages", async () => {
  const d = new FakeDriver();
  d.outcomes.fill = new Error('could not fill with value s3cr3t-literal');
  const c = collect();
  const out = await runAutomation(
    d,
    automation([
      {
        id: 'a',
        action: 'fill',
        target: { kind: 'id', value: 'pw' },
        params: { value: 's3cr3t-literal', valueMode: 'secret' },
      },
    ]),
    c,
  );
  expect(d.calls[0].params.value).toBe('s3cr3t-literal'); // driver still gets it
  expect(out.steps[0].error).not.toContain('s3cr3t-literal'); // logs don't
  expect(out.steps[0].error).toContain('***');
});

test('saveFile writes the scrape bag (or an interpolated template) via ctx.writeFile', async () => {
  const d = new FakeDriver();
  d.outcomes.scrape = { value: 'Acme' };
  const writes: { path: string; content: string }[] = [];
  const events: StepResult[] = [];
  const out = await runAutomation(
    d,
    automation([
      { id: 's', action: 'scrape', target: { kind: 'css', value: 'h1' }, params: { saveAs: 'name' } },
      { id: 'f1', action: 'saveFile', params: { path: 'out.json' } }, // blank content → whole bag as JSON
      { id: 'f2', action: 'saveFile', params: { value: 'Hello ${scraped.name}', path: 'msg.txt' } },
    ]),
    {
      scraped: {},
      emit: (r) => events.push(r),
      writeFile: async (path, content) => {
        writes.push({ path, content });
        return `/abs/${path}`;
      },
    },
  );
  expect(out.status).toBe('passed');
  // the driver was never asked to run saveFile (it's a host-free side effect)
  expect(d.calls.some((cl) => cl.action === 'saveFile')).toBe(false);
  expect(writes[0].path).toBe('out.json');
  expect(JSON.parse(writes[0].content)).toEqual({ name: 'Acme' });
  expect(writes[1]).toEqual({ path: 'msg.txt', content: 'Hello Acme' });
  // the resolved path is recorded on the step for display
  expect(out.steps.find((s) => s.stepId === 'f1')?.selector).toBe('/abs/out.json');
});

test('saveFile fails the step cleanly when no writer is provided', async () => {
  const d = new FakeDriver();
  const c = collect();
  const out = await runAutomation(d, automation([{ id: 'f', action: 'saveFile', params: { path: 'x.json' } }]), c);
  expect(out.status).toBe('failed');
  expect(out.steps[0].error).toContain('file');
});

/** A saveArtifact stub that records what it was asked to persist and returns paths. */
function artifactStub() {
  const saved: Array<{ index: string; captures: { html?: string; screenshot?: string }; label?: string }> = [];
  return {
    saved,
    saveArtifact: async (
      index: string,
      captures: { html?: string; screenshot?: string },
      label?: string,
    ): Promise<{ htmlPath?: string; screenshotPath?: string }> => {
      saved.push({ index, captures, label });
      return {
        htmlPath: captures.html ? `automation-runs/${index}.html` : undefined,
        screenshotPath: captures.screenshot ? `automation-runs/${index}.png` : undefined,
      };
    },
  };
}

test('snapshot step persists captured HTML + screenshot to file paths', async () => {
  const d = new FakeDriver();
  d.outcomes.snapshot = { html: '<html>hi</html>', screenshot: 'data:image/png;base64,AAAA' };
  const c = collect();
  const art = artifactStub();
  const out = await runAutomation(
    d,
    automation([{ id: 'snap', action: 'snapshot', params: { value: 'after login' } }]),
    { ...c, saveArtifact: art.saveArtifact },
  );
  expect(out.status).toBe('passed');
  const step = out.steps[0];
  expect(step.htmlPath).toBe('automation-runs/0.html');
  expect(step.screenshotPath).toBe('automation-runs/0.png');
  // the label is handed through for the filename
  expect(art.saved[0]).toMatchObject({ index: '0', label: 'after login' });
  // nothing inline once it's persisted to files
  expect(step.screenshot).toBeUndefined();
});

test("snapshot keeps the screenshot inline when there's no output dir to persist into", async () => {
  const d = new FakeDriver();
  d.outcomes.snapshot = { html: '<html/>', screenshot: 'data:image/png;base64,BBBB' };
  const c = collect();
  const out = await runAutomation(d, automation([{ id: 'snap', action: 'snapshot' }]), c);
  expect(out.status).toBe('passed');
  expect(out.steps[0].screenshot).toBe('data:image/png;base64,BBBB');
  expect(out.steps[0].screenshotPath).toBeUndefined();
});

test('newTab normalizes a scheme-less url like goto', async () => {
  const d = new FakeDriver();
  const c = collect();
  const out = await runAutomation(
    d,
    automation([{ id: 't', action: 'newTab', params: { url: 'example.com/app' } }]),
    c,
  );
  expect(out.status).toBe('passed');
  expect(d.calls[0]).toMatchObject({ action: 'newTab', params: { url: 'https://example.com/app' } });
});

test('setFiles interpolates ${run.dir} into the file path passed to the driver', async () => {
  const d = new FakeDriver();
  const events: StepResult[] = [];
  const out = await runAutomation(
    d,
    automation([
      { id: 'u', action: 'setFiles', target: { kind: 'id', value: 'file' }, params: { value: '${run.dir}/a.csv' } },
    ]),
    { scraped: {}, dir: '/tmp/run1', emit: (r) => events.push(r) },
  );
  expect(out.status).toBe('passed');
  expect(d.calls[0]).toMatchObject({ action: 'setFiles', params: { value: '/tmp/run1/a.csv' } });
});

test("a failed expectation stops the run early (fail-fast), later steps don't run", async () => {
  const d = new FakeDriver();
  d.outcomes.expectValue = new Error('expected "x" but got "y"');
  const c = collect();
  const out = await runAutomation(
    d,
    automation([
      { id: 'e', action: 'expectValue', target: { kind: 'id', value: 'f' }, params: { value: 'x' } },
      { id: 'after', action: 'click', target: { kind: 'id', value: 'go' } },
    ]),
    c,
  );
  expect(out.status).toBe('failed');
  expect(out.steps[0].status).toBe('failed');
  // the assertion aborted the run — the click after it never executed
  expect(d.calls.some((cl) => cl.action === 'click')).toBe(false);
});

test('beforeStep is consulted before every step (incl. the start goto), with prevAction', async () => {
  const d = new FakeDriver();
  const c = collect();
  const seen: Array<{ index: string; action: string; prevAction?: string }> = [];
  await runAutomation(
    d,
    automation([{ id: 'a', action: 'click', target: { kind: 'testid', value: 'go' } }], { startUrl: 'http://x' }),
    {
      ...c,
      beforeStep: async ({ index, step, prevAction }) => {
        seen.push({ index, action: step.action, prevAction });
        return 'go';
      },
    },
  );
  expect(seen).toEqual([
    { index: 'start', action: 'goto', prevAction: undefined },
    { index: '0', action: 'click', prevAction: 'goto' },
  ]);
});

test('beforeStep returning "abort" stops the run after the steps that already ran', async () => {
  const d = new FakeDriver();
  const c = collect();
  const out = await runAutomation(
    d,
    automation([
      { id: 'a', action: 'click', target: { kind: 'testid', value: 'one' } },
      { id: 'b', action: 'click', target: { kind: 'testid', value: 'two' } },
    ]),
    { ...c, beforeStep: async ({ index }) => (index === '1' ? 'abort' : 'go') },
  );
  // first step ran; the abort fired before the second, which never executed
  expect(d.calls).toHaveLength(1);
  expect(d.calls[0].target?.value).toBe('one');
  expect(out.steps).toHaveLength(1);
});

test('captureFrame persists a per-step frame on a meaningful step', async () => {
  const d = new FakeDriver();
  d.outcomes.click = { html: '<html>screen</html>', screenshot: 'data:image/jpeg;base64,DDDD' };
  const c = collect();
  const art = artifactStub();
  const out = await runAutomation(
    d,
    automation([{ id: 'c', action: 'click', target: { kind: 'testid', value: 'go' } }]),
    { ...c, saveArtifact: art.saveArtifact, captureFrame: (a) => a === 'click' },
  );
  expect(out.status).toBe('passed');
  expect(out.steps[0].htmlPath).toBe('automation-runs/0.html');
  expect(out.steps[0].screenshotPath).toBe('automation-runs/0.png');
});

test('without captureFrame, a normal step does not persist a frame even if one is returned', async () => {
  const d = new FakeDriver();
  d.outcomes.click = { html: '<html/>', screenshot: 'data:image/jpeg;base64,EEEE' };
  const c = collect();
  const art = artifactStub();
  const out = await runAutomation(
    d,
    automation([{ id: 'c', action: 'click', target: { kind: 'testid', value: 'go' } }]),
    { ...c, saveArtifact: art.saveArtifact },
  );
  expect(out.steps[0].htmlPath).toBeUndefined();
  expect(out.steps[0].screenshotPath).toBeUndefined();
  expect(art.saved).toHaveLength(0);
});

test('a failed step persists the page state captured at the moment it broke', async () => {
  const d = new FakeDriver();
  const err = new Error('element not found') as Error & { outcome?: ActionOutcome };
  err.outcome = { finalUrl: 'http://x/broken', html: '<html>broken</html>', screenshot: 'data:image/jpeg;base64,CCCC' };
  d.outcomes.click = err;
  const c = collect();
  const art = artifactStub();
  const out = await runAutomation(
    d,
    automation([{ id: 'c', action: 'click', target: { kind: 'testid', value: 'go' } }]),
    { ...c, saveArtifact: art.saveArtifact },
  );
  expect(out.status).toBe('failed');
  const step = out.steps[0];
  expect(step.finalUrl).toBe('http://x/broken');
  expect(step.htmlPath).toBe('automation-runs/0.html');
  expect(step.screenshotPath).toBe('automation-runs/0.png');
});

test('extractWithRegex: bare pattern, /pattern/flags, capture group, no match, empty', () => {
  // bare pattern → whole match (no group)
  expect(extractWithRegex('build #1234 ok', '\\d+')).toBe('1234');
  // capture group wins over the whole match
  expect(extractWithRegex('digest: sha256:abc123', 'sha256:(\\S+)')).toBe('abc123');
  // /pattern/flags literal with multiline, across lines
  expect(extractWithRegex('name: app\nsha256: deadbeef\n', '/^sha256:\\s*(\\S+)/m')).toBe('deadbeef');
  // no match → empty string
  expect(extractWithRegex('nothing here', 'sha256:(\\S+)')).toBe('');
  // empty pattern → text unchanged
  expect(extractWithRegex('keep me', '')).toBe('keep me');
  expect(extractWithRegex('keep me', undefined)).toBe('keep me');
});

test('scrape applies a regex to the captured text before storing it', async () => {
  const d = new FakeDriver();
  d.outcomes.scrape = { value: 'Image digest is sha256:cafebabe1234 (done)' };
  const c = collect();
  const out = await runAutomation(
    d,
    automation([
      {
        id: 's',
        action: 'scrape',
        target: { kind: 'css', value: '.digest' },
        params: { saveAs: 'sha', regex: 'sha256:(\\S+)' },
      },
      // the extracted value flows into later interpolation
      { id: 'f', action: 'fill', target: { kind: 'id', value: 'q' }, params: { value: 'got ${scraped.sha}' } },
    ]),
    c,
  );
  expect(out.status).toBe('passed');
  expect(out.scraped.sha).toBe('cafebabe1234');
  expect(d.calls[1].params.value).toBe('got cafebabe1234');
});

test('an invalid scrape regex fails the step with a clear error', async () => {
  const d = new FakeDriver();
  d.outcomes.scrape = { value: 'anything' };
  const c = collect();
  const out = await runAutomation(
    d,
    automation([
      { id: 's', action: 'scrape', target: { kind: 'css', value: 'h1' }, params: { saveAs: 'x', regex: '(' } },
    ]),
    c,
  );
  expect(out.status).toBe('failed');
  expect(out.steps[0].error?.toLowerCase()).toContain('regular expression');
});
