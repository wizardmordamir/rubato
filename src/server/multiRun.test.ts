import { describe, expect, test } from 'bun:test';
import type { Automation } from '../shared/automation';
import { MAX_PARALLEL_TARGETS, planAutomationRuns } from './multiRun';

const auto: Automation = {
  id: 'a1',
  name: 'demo',
  startUrl: 'https://orig',
  steps: [],
  createdAt: 0,
  updatedAt: 0,
};

describe('planAutomationRuns', () => {
  test('no urls → a single run with the original automation + base vars', () => {
    const { specs, skipped } = planAutomationRuns(auto, { headless: false, keepOpen: true, variables: { A: '1' } });
    expect(skipped).toBe(0);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ headless: false, keepOpen: true, variables: { A: '1' } });
    expect(specs[0].automation.startUrl).toBe('https://orig'); // unchanged
    expect(specs[0].targetUrl).toBeUndefined();
  });

  test('urls → one run per URL, each overriding startUrl + injecting TARGET_URL', () => {
    const { specs } = planAutomationRuns(auto, { variables: { A: '1' }, urls: ['https://a', 'https://b'] });
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.automation.startUrl)).toEqual(['https://a', 'https://b']);
    expect(specs.map((s) => s.targetUrl)).toEqual(['https://a', 'https://b']);
    expect(specs[0].variables).toEqual({ A: '1', TARGET_URL: 'https://a' });
    // headless defaults true; the base automation is not mutated.
    expect(specs[0].headless).toBe(true);
    expect(auto.startUrl).toBe('https://orig');
  });

  test('blank/non-string urls are dropped', () => {
    const { specs } = planAutomationRuns(auto, { urls: ['  ', 'https://a', '', 5 as unknown as string] });
    expect(specs.map((s) => s.targetUrl)).toEqual(['https://a']);
  });

  test('caps at MAX_PARALLEL_TARGETS and reports the rest as skipped', () => {
    const many = Array.from({ length: MAX_PARALLEL_TARGETS + 3 }, (_, i) => `https://h${i}`);
    const { specs, skipped } = planAutomationRuns(auto, { urls: many });
    expect(specs).toHaveLength(MAX_PARALLEL_TARGETS);
    expect(skipped).toBe(3);
  });

  test('rows → one run per row, merging row vars over base vars', () => {
    const { specs } = planAutomationRuns(auto, {
      variables: { task: 'T-1' },
      rows: [
        { app: 'alpha', version: '1.0', sha: 'sha256:a' },
        { app: 'beta', version: '2.0', sha: 'sha256:b' },
      ],
    });
    expect(specs).toHaveLength(2);
    expect(specs[0].variables).toEqual({ task: 'T-1', app: 'alpha', version: '1.0', sha: 'sha256:a' });
    expect(specs[1].variables).toEqual({ task: 'T-1', app: 'beta', version: '2.0', sha: 'sha256:b' });
    // no `url` column → original startUrl, no TARGET_URL, base automation untouched
    expect(specs[0].automation.startUrl).toBe('https://orig');
    expect(specs[0].targetUrl).toBeUndefined();
    expect(auto.startUrl).toBe('https://orig');
  });

  test("a row's `url` column overrides startUrl + sets TARGET_URL (and isn't a plain var)", () => {
    const { specs } = planAutomationRuns(auto, {
      rows: [{ url: 'https://jenkins/job/alpha', task: 'T-9', version: '3.1' }],
    });
    expect(specs[0].automation.startUrl).toBe('https://jenkins/job/alpha');
    expect(specs[0].targetUrl).toBe('https://jenkins/job/alpha');
    expect(specs[0].variables).toEqual({ task: 'T-9', version: '3.1', TARGET_URL: 'https://jenkins/job/alpha' });
    expect(specs[0].variables.url).toBeUndefined();
  });

  test('rows wins over urls; non-object/empty rows are dropped; values coerced to strings', () => {
    const { specs } = planAutomationRuns(auto, {
      urls: ['https://ignored'],
      rows: [{ app: 'x', n: 5 as unknown as string }, null as unknown as Record<string, string>, {}],
    });
    expect(specs).toHaveLength(1); // urls ignored, the null + {} rows dropped
    expect(specs[0].variables).toEqual({ app: 'x', n: '5' });
  });

  test('rows cap + skipped count', () => {
    const rows = Array.from({ length: MAX_PARALLEL_TARGETS + 2 }, (_, i) => ({ app: `a${i}` }));
    const { specs, skipped } = planAutomationRuns(auto, { rows });
    expect(specs).toHaveLength(MAX_PARALLEL_TARGETS);
    expect(skipped).toBe(2);
  });
});
