import { describe, expect, test } from 'bun:test';
import { buildStatus, fmtDuration } from './format';
import type { JenkinsBuild } from './types';

function build(over: Partial<JenkinsBuild>): JenkinsBuild {
  return { number: 1, url: '', result: 'SUCCESS', building: false, timestamp: 0, ...over };
}

describe('fmtDuration', () => {
  test('formats seconds and minutes, dashes when unknown', () => {
    expect(fmtDuration(45_000)).toBe('45s');
    expect(fmtDuration(125_000)).toBe('2m 5s');
    expect(fmtDuration(0)).toBe('—');
    expect(fmtDuration(undefined)).toBe('—');
  });
});

describe('buildStatus', () => {
  test('BUILDING while in progress, else the result', () => {
    expect(buildStatus(build({ building: true }))).toBe('BUILDING');
    expect(buildStatus(build({ result: 'FAILURE' }))).toBe('FAILURE');
    expect(buildStatus(build({ result: null }))).toBe('UNKNOWN');
  });
});
