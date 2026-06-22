import { describe, expect, test } from 'bun:test';
import { BUILD_OUTPUT_FAILED, buildIsGreen } from './buildOutputGate';

/**
 * Regression guard for task #297 — the per-task executor verify must NOT trust a
 * build's exit code alone. A build script can exit 0 while FAILING (a trailing
 * `|| true`, a swallowed catch); the gate must read the OUTPUT for failure markers
 * too, exactly like the promotion watchdog does.
 */
describe('buildIsGreen (build-output gate, #297)', () => {
  test('green: exit 0 and no failure markers in the output', () => {
    expect(buildIsGreen({ code: 0, out: 'vite v7 building...\n✓ 1200 modules transformed.\ndone' })).toBe(true);
  });

  test('red: a non-zero exit is red even with clean output', () => {
    expect(buildIsGreen({ code: 1, out: '' })).toBe(false);
  });

  // The crux of #297: exit 0 + a real failure printed to the output ⇒ still RED.
  test('red: exit 0 but the output shows a Rollup "is not exported by" failure', () => {
    const out = 'RollupError: "foo" is not exported by "bar.ts"\nerror during build:\n✗ Build failed in 2.0s';
    expect(buildIsGreen({ code: 0, out })).toBe(false);
  });

  test('red: exit 0 but the output shows "Could not resolve"', () => {
    const out = '[vite]: Rollup failed to resolve import "lucide-react".\nerror during build:';
    expect(buildIsGreen({ code: 0, out })).toBe(false);
  });

  test.each([
    'error during build:',
    'Build failed in 1.2s',
    '✗ Build failed',
    'RollupError: boom',
    'Could not resolve "x"',
    'is not exported by "y"',
    'Transform failed with 1 error',
    'esbuild: error: unexpected token',
  ])('exit-0 build with marker %p is RED', (marker) => {
    expect(buildIsGreen({ code: 0, out: `noise\n${marker}\nmore noise` })).toBe(false);
  });

  test('the marker set matches the promotion watchdog regex (keep in sync)', () => {
    // If this drifts, update both ~/.taskq/main-health-watchdog.ts + gate.ts and this list.
    // (Substring checks, not an exact source compare — the `✗ Build` glyph is exercised
    //  behaviourally above; an exact source match is brittle across char encodings.)
    for (const marker of [
      'error during build',
      'Build failed',
      'RollupError',
      'Could not resolve',
      'is not exported by',
      'Transform failed',
      'esbuild.*error',
    ]) {
      expect(BUILD_OUTPUT_FAILED.source).toContain(marker);
    }
    expect(BUILD_OUTPUT_FAILED.flags).toContain('i');
  });
});
