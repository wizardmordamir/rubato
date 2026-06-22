/**
 * Build-output failure gate (#297) — a build script can exit 0 while FAILING (a
 * trailing `|| true`, a swallowed catch, a child exit code that never propagates).
 * The promotion watchdog (`~/.taskq/main-health-watchdog.ts`) was hardened to treat
 * known bundler/build failure markers in the build OUTPUT as RED even when the exit
 * code is 0 — that is exactly how a broken `ca` was once certified green and promoted
 * to main. The per-task executor verify (the in-app integration gate in `gate.ts` and
 * the false-done regression check in `doneCheck.ts`) must apply the SAME scan so NO
 * checkpoint trusts the exit code alone.
 *
 * Keep {@link BUILD_OUTPUT_FAILED} in sync with the watchdog's regex.
 */

/** Known build/bundler failure markers that can appear even on an exit-0 build. */
export const BUILD_OUTPUT_FAILED =
  /error during build|Build failed|✗ Build|RollupError|Could not resolve|is not exported by|Transform failed|esbuild.*error/i;

/** A build counts as GREEN only when it exits 0 AND prints no known failure marker. */
export function buildIsGreen(res: { code: number; out: string }): boolean {
  return res.code === 0 && !BUILD_OUTPUT_FAILED.test(res.out);
}
