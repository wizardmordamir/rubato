import { expect, test } from 'bun:test';
import type { AutomationRunRecord } from './automation';
import type { CaptureManifest } from './capture';
import { manifestToMoments, runToMoments } from './timeline';

test('manifestToMoments maps records → moments with artifact URLs', () => {
  const manifest: CaptureManifest = {
    id: 'cap-1',
    startedAt: 0,
    records: [
      { seq: 0, ts: 0, url: 'https://x', kind: 'start', htmlFile: 'html/0.html', screenshotFile: 'shot/0.jpg' },
      { seq: 1, ts: 0, url: 'https://x/2', kind: 'action', action: 'click' },
    ],
  };
  const m = manifestToMoments(manifest);
  expect(m).toHaveLength(2);
  expect(m[0].label).toBe('start');
  expect(m[0].screenshotUrl).toContain('/api/capture/cap-1/artifact?path=');
  expect(m[0].htmlUrl).toContain(encodeURIComponent('html/0.html'));
  expect(m[1].label).toBe('action · click');
  expect(m[1].action).toBe('click');
  expect(m[1].screenshotUrl).toBeUndefined();
});

test('runToMoments maps steps → moments, drops running, prefers persisted paths', () => {
  const run: AutomationRunRecord = {
    id: 1,
    automation: 'a',
    status: 'failed',
    scraped: {},
    startedAt: 0,
    durationMs: 10,
    steps: [
      { stepId: 's0', index: '0', action: 'click', status: 'running', durationMs: 0 },
      {
        stepId: 's0',
        index: '0',
        action: 'click',
        status: 'passed',
        durationMs: 5,
        selector: 'role=button',
        screenshotPath: 'automation-runs/0.png',
        htmlPath: 'automation-runs/0.html',
      },
      {
        stepId: 's1',
        index: '1',
        action: 'fill',
        status: 'failed',
        durationMs: 5,
        error: 'boom',
        screenshot: 'data:image/jpeg;base64,AAAA',
      },
    ],
  };
  const m = runToMoments(run);
  expect(m).toHaveLength(2); // the "running" placeholder is dropped
  expect(m[0].label).toBe('click · role=button');
  expect(m[0].status).toBe('passed');
  expect(m[0].screenshotUrl).toBe('/api/files/raw?path=automation-runs%2F0.png');
  // no persisted path → fall back to the inline data: URL
  expect(m[1].screenshotUrl).toBe('data:image/jpeg;base64,AAAA');
  expect(m[1].error).toBe('boom');
});
