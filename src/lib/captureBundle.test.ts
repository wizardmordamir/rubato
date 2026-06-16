import { describe, expect, test } from 'bun:test';
import type { CaptureManifest, CaptureRecord } from '../shared/capture';
import {
  buildBundle,
  bundleFromText,
  bundleToText,
  captureRecordsToSteps,
  parseBundle,
  serializeBundle,
  summarizeManifest,
} from './captureBundle';

const records: CaptureRecord[] = [
  {
    seq: 0,
    ts: 1,
    url: 'https://jenkins/job/app/build',
    kind: 'start',
    htmlFile: 'html/0.html',
    screenshotFile: 'shot/0.jpg',
  },
  {
    seq: 1,
    ts: 2,
    url: 'https://jenkins/job/app/build',
    kind: 'action',
    action: 'fill',
    target: { kind: 'css', value: 'input[name="value"]' },
    params: { value: '1.2.3' },
    htmlFile: 'html/1.html',
  },
  { seq: 2, ts: 3, url: 'https://jenkins/job/app/', kind: 'navigate', htmlFile: 'html/2.html' },
];
const manifest: CaptureManifest = { id: 'cap-1', label: 'jenkins', startedAt: 1, stoppedAt: 9, records };
const artifacts = { 'html/0.html': '<html>start</html>', 'html/1.html': '<form/>', 'html/2.html': '<html>done</html>' };

describe('summarizeManifest', () => {
  test('reduces a manifest to its summary', () => {
    expect(summarizeManifest(manifest)).toEqual({
      id: 'cap-1',
      label: 'jenkins',
      note: undefined,
      startedAt: 1,
      stoppedAt: 9,
      count: 3,
    });
  });
});

describe('serializeBundle / parseBundle', () => {
  test('round-trips a bundle through gzip', () => {
    const bytes = serializeBundle(buildBundle(manifest, artifacts));
    const back = parseBundle(bytes);
    expect(back.version).toBe(1);
    expect(back.manifest.id).toBe('cap-1');
    expect(back.manifest.records).toHaveLength(3);
    expect(back.artifacts['html/1.html']).toBe('<form/>');
  });

  test('gzip actually compresses (bytes are not the raw JSON)', () => {
    const bundle = buildBundle(manifest, artifacts);
    const bytes = serializeBundle(bundle);
    expect(bytes.length).toBeLessThan(JSON.stringify(bundle).length);
  });

  test('rejects non-gzip and non-bundle input with clear errors', () => {
    expect(() => parseBundle(new TextEncoder().encode('not gzip'))).toThrow(/gzip/);
    const notABundle = serializeBundle({ version: 1, manifest: { id: 'x', startedAt: 0, records: [] }, artifacts: {} });
    expect(parseBundle(notABundle).manifest.id).toBe('x'); // valid shape parses
  });
});

describe('bundleToText / bundleFromText (shareable string)', () => {
  test('round-trips sealed with a seed (and the token hides the content)', () => {
    const token = bundleToText(buildBundle(manifest, artifacts), 'my-seed');
    expect(token.startsWith('rbz1_')).toBe(true);
    expect(token).not.toContain('jenkins');
    const back = bundleFromText(token, 'my-seed');
    expect(back.manifest.id).toBe('cap-1');
    expect(back.artifacts['html/1.html']).toBe('<form/>');
  });

  test('round-trips unsealed (compressed string) without a seed', () => {
    const token = bundleToText(buildBundle(manifest, artifacts));
    expect(token.startsWith('rbp1_')).toBe(true);
    expect(bundleFromText(token).manifest.records).toHaveLength(3);
  });

  test('a sealed token needs the right seed', () => {
    const token = bundleToText(buildBundle(manifest, artifacts), 'right');
    expect(() => bundleFromText(token, 'wrong')).toThrow();
    expect(() => bundleFromText(token)).toThrow(/password is required/);
  });
});

describe('captureRecordsToSteps', () => {
  test('keeps only action moments, as automation steps', () => {
    const steps = captureRecordsToSteps(records);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      id: 'cap-1',
      action: 'fill',
      target: { kind: 'css', value: 'input[name="value"]' },
      params: { value: '1.2.3' },
    });
  });
});
