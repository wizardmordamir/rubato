import { describe, expect, test } from 'bun:test';
import { clampNumber, normalizeArtStyles, normalizePerformance, resolveAspect } from './art';

describe('normalizeArtStyles', () => {
  test('drops unknown styles, dedupes, and force-includes the Fooocus V2 engine', () => {
    expect(normalizeArtStyles(['Fooocus Cinematic', 'made up style', 'Fooocus Cinematic'])).toEqual([
      'Fooocus V2',
      'Fooocus Cinematic',
    ]);
  });
  test('empty/undefined falls back to the default stack (with V2)', () => {
    expect(normalizeArtStyles(undefined)).toContain('Fooocus V2');
    expect(normalizeArtStyles([])).toContain('Fooocus V2');
    expect(normalizeArtStyles(['nonsense'])).toContain('Fooocus V2');
  });
});

describe('normalizePerformance', () => {
  test('accepts known presets, rejects everything else', () => {
    expect(normalizePerformance('Quality')).toBe('Quality');
    expect(normalizePerformance('Speed')).toBe('Speed');
    expect(normalizePerformance('Lightning')).toBe('Lightning');
    expect(normalizePerformance('Bogus')).toBeUndefined();
    expect(normalizePerformance(42)).toBeUndefined();
    expect(normalizePerformance(undefined)).toBeUndefined();
  });
});

describe('clampNumber', () => {
  test('clamps into range and rejects non-finite', () => {
    expect(clampNumber(50, 1, 30)).toBe(30);
    expect(clampNumber(-5, 0, 30)).toBe(0);
    expect(clampNumber(7, 1, 30)).toBe(7);
    expect(clampNumber('nope', 1, 30)).toBeUndefined();
    expect(clampNumber(Number.NaN, 1, 30)).toBeUndefined();
  });
});

describe('resolveAspect', () => {
  test('named keys map to Fooocus-valid pairs; raw W*H parsed; junk → square', () => {
    expect(resolveAspect('portrait')).toEqual({ width: 896, height: 1152 });
    expect(resolveAspect('landscape')).toEqual({ width: 1152, height: 896 });
    expect(resolveAspect('1216*832')).toEqual({ width: 1216, height: 832 });
    expect(resolveAspect('1216x832')).toEqual({ width: 1216, height: 832 });
    expect(resolveAspect('garbage')).toEqual({ width: 1024, height: 1024 });
    expect(resolveAspect(undefined)).toEqual({ width: 1024, height: 1024 });
  });
});
