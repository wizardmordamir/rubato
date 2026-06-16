import { describe, expect, test } from 'bun:test';
import { optionalEnv, setEnvVar } from './env';

// RUBATO_HOME is pointed at a throwaway dir by the test preload, so these write
// to an isolated ~/.rubato/.env, never the real one.
describe('setEnvVar', () => {
  test('writes a new var and reads it back, then updates it in place', () => {
    setEnvVar('RUBATO_ENV_TEST_A', 'first');
    expect(optionalEnv('RUBATO_ENV_TEST_A')).toBe('first');

    setEnvVar('RUBATO_ENV_TEST_A', 'second');
    expect(optionalEnv('RUBATO_ENV_TEST_A')).toBe('second');
  });

  test('keeps other vars when upserting', () => {
    setEnvVar('RUBATO_ENV_TEST_B', 'bee');
    setEnvVar('RUBATO_ENV_TEST_C', 'see');
    setEnvVar('RUBATO_ENV_TEST_B', 'bee2');
    expect(optionalEnv('RUBATO_ENV_TEST_B')).toBe('bee2');
    expect(optionalEnv('RUBATO_ENV_TEST_C')).toBe('see');
  });

  test('strips newlines from the value (single-line tokens)', () => {
    setEnvVar('RUBATO_ENV_TEST_D', 'line1\nline2');
    expect(optionalEnv('RUBATO_ENV_TEST_D')).toBe('line1 line2');
  });

  test('rejects an invalid var name', () => {
    expect(() => setEnvVar('not valid', 'x')).toThrow(/invalid env var name/);
    expect(() => setEnvVar('1leading', 'x')).toThrow(/invalid env var name/);
  });
});
