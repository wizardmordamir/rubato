import { describe, expect, test } from 'bun:test';
import { capImages } from './router';

describe('capImages', () => {
  test('strips data-URL headers, leaving raw base64', () => {
    const out = capImages(['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB', 'data:image/webp;base64,CCCC']);
    expect(out).toEqual(['AAAA', 'BBBB', 'CCCC']);
  });

  test('passes through already-raw base64 untouched', () => {
    expect(capImages(['RAWBASE64'])).toEqual(['RAWBASE64']);
  });

  test('drops non-strings and empties; returns undefined when nothing usable', () => {
    expect(capImages([123, null, '', { x: 1 }])).toBeUndefined();
    expect(capImages('not-an-array')).toBeUndefined();
    expect(capImages(undefined)).toBeUndefined();
  });

  test('caps the number of images at 6', () => {
    const many = Array.from({ length: 10 }, (_, i) => `data:image/png;base64,IMG${i}`);
    expect(capImages(many)).toHaveLength(6);
  });
});
