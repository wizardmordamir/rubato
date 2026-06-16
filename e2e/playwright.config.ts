import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * rubato's own e2e suite — boots the real `rubato-serve` and drives it in a
 * browser. Kept deliberately self-isolating so it never touches your real
 * registry and so several worktrees can run it at once:
 *
 *  - RUBATO_HOME points at a throwaway, gitignored dir (`*.ignore*`), so the run
 *    sees an empty app registry / config / db instead of `~/.rubato`.
 *  - RUBATO_PORT is read from the env (default below), so each worktree can pick
 *    its own port. `use.baseURL` follows it, so specs use relative paths.
 *
 * Drives your installed Google Chrome (`channel: "chrome"`) — no browser download
 * needed. On a box without Chrome, run `bun run setup --browsers` and switch the
 * project to bundled Chromium.
 */
const ROOT = resolve(import.meta.dirname, "..");
const PORT = process.env.RUBATO_PORT ?? "4799";
const BASE_URL = `http://localhost:${PORT}`;
const RUBATO_HOME = resolve(import.meta.dirname, ".rubato-home.ignore");
// Write run reports to the REAL ~/.rubato (NOT the throwaway home above), so a
// real serve's Test Reports page shows them. Matches src/lib/config TEST_REPORTS_DIR.
const TEST_REPORTS_DIR = process.env.RUBATO_TEST_REPORTS_DIR ?? resolve(homedir(), ".rubato", "test-reports");

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // Seed the throwaway RUBATO_HOME with a test app registry (shared provisioning).
  globalSetup: resolve(import.meta.dirname, "global-setup.ts"),
  outputDir: resolve(import.meta.dirname, "test-results.ignore"),
  timeout: 30 * 1000,
  expect: { timeout: 15 * 1000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Funnel e2e results (+ screenshot/trace) into the shared cwip TestRunReport so
  // they show up in the Test Reports page alongside `bun run test:report` runs.
  reporter: [["line"], ["cwip/e2e/reporter", { dir: TEST_REPORTS_DIR, label: "e2e", meta: { mode: "e2e" } }]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [{ name: "Google Chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: {
    command: "bun run src/scripts/serve.ts",
    url: `${BASE_URL}/api/health`,
    cwd: ROOT,
    timeout: 30 * 1000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RUBATO_PORT: PORT, RUBATO_HOME },
  },
});
