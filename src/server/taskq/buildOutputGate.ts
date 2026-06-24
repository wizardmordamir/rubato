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
 * The marker set + green decision are the ONE canonical primitive in `cwip/build`,
 * shared by every checkpoint (an app's build orchestrator, this executor gate, and the
 * promotion watchdog) so they can never drift. This module re-exports them under the
 * local names its consumers already use — `BUILD_OUTPUT_FAILED` aliases the canonical
 * `BUILD_FAILURE_MARKERS`. (It used to be a hand-copied regex kept aligned only by a
 * comment.)
 */
export { BUILD_FAILURE_MARKERS as BUILD_OUTPUT_FAILED, buildIsGreen } from 'cwip/build';
