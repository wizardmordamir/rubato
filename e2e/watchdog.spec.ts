import { expect, test } from "@playwright/test";
import type {
  ConfigPatchResult,
  WatchdogAgentResult,
  WatchdogSnapshot,
} from "../src/shared/orchestration";

/**
 * Watchdog panel (ScheduleCard) — agent lifecycle buttons + schedule display:
 *  - launchd agent badge and Start/Reload/Stop button states
 *  - "Next run" label across the four nextActionLabel branches
 *  - Last tick display
 *  - RESUME_AT presets and Clear
 *
 * All GET /api/orchestration/watchdog responses are stubbed via page.route() so
 * the tests never touch real launchctl or a live drain.config file.  POST
 * endpoints are also intercepted so mutations don't hit the OS.
 *
 * The orchestration page must be enabled via /api/ui before navigation.
 */

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** A minimal, fully-valid WatchdogSnapshot. Override specific fields per test. */
function baseSnap(overrides: Partial<WatchdogSnapshot> = {}): WatchdogSnapshot {
  return {
    notesDir: "/tmp/e2e-watchdog-notes",
    orchestrationDir: "/tmp/e2e-watchdog-notes/orchestration",
    config: { enabled: true, jobs: 2, extra: {} },
    running: false,
    pending: [],
    workers: [],
    instances: [],
    counts: { ready: 0, claimed: 0, blocked: 0, notReady: 0, done: 0 },
    readyTitles: [],
    launchd: { exists: true, loaded: true, intervalSeconds: 300 },
    problems: [],
    logs: [],
    files: [],
    commands: [],
    now: new Date().toISOString(),
    ...overrides,
  };
}

function okAgentResult(action: "start" | "stop" | "restart", loaded: boolean): WatchdogAgentResult {
  return { action, ok: true, loaded, message: `agent ${action}ed` };
}

const BASE_PATCH_OK: ConfigPatchResult = {
  config: { enabled: true, jobs: 2, extra: {} },
  changed: [],
};

/** Stub the watchdog GET to return `snap` for every poll. */
async function stubWatchdog(page: Parameters<typeof test>[1] extends (...args: infer A) => unknown ? A[0] : never, snap: WatchdogSnapshot) {
  await page.route(
    (url) => url.pathname === "/api/orchestration/watchdog",
    (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snap) }),
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

test.beforeEach(async ({ request }) => {
  // The orchestration page is opt-in; enable it for each test.
  await request.post("/api/ui", { data: { pages: { orchestration: true } } });
});

// ─── Agent state & badge ─────────────────────────────────────────────────────

test("shows 'not loaded' badge and enables Start agent when launchd is unloaded", async ({ page }) => {
  await stubWatchdog(page, baseSnap({ launchd: { exists: false, loaded: false } }));
  await page.route(
    (url) => url.pathname === "/api/orchestration/watchdog/agent",
    (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(okAgentResult("start", true)) }),
  );

  await page.goto("/orchestration");
  await expect(page.getByRole("heading", { name: "Orchestration" })).toBeVisible();

  // Badge in ScheduleCard.
  await expect(page.getByText(/launchd agent not loaded/i)).toBeVisible();

  // "Next run" → unloaded branch.
  await expect(page.getByText("agent stopped — start it to schedule")).toBeVisible();

  // Start agent is enabled (unloaded → primary action).
  await expect(page.getByRole("button", { name: "Start agent" })).toBeEnabled();

  // Stop agent is disabled (nothing to stop).
  await expect(page.getByRole("button", { name: "Stop agent" })).toBeDisabled();
});

test("shows 'loaded' badge when launchd is loaded", async ({ page }) => {
  await stubWatchdog(page, baseSnap({ launchd: { exists: true, loaded: true, intervalSeconds: 300 } }));

  await page.goto("/orchestration");

  await expect(page.getByText(/launchd agent loaded/i)).toBeVisible();

  // Start agent is disabled when already loaded.
  await expect(page.getByRole("button", { name: "Start agent" })).toBeDisabled();

  // Stop agent is enabled (can unload a loaded agent).
  await expect(page.getByRole("button", { name: "Stop agent" })).toBeEnabled();
});

// ─── Agent button POSTs ───────────────────────────────────────────────────────

test("Start agent POSTs { action: 'start' } to /watchdog/agent", async ({ page }) => {
  // Use an unloaded snap so the Start agent button is enabled.
  await stubWatchdog(page, baseSnap({ launchd: { exists: false, loaded: false } }));

  const captured: { action: string }[] = [];
  await page.route(
    (url) => url.pathname === "/api/orchestration/watchdog/agent",
    async (route) => {
      captured.push(route.request().postDataJSON() as { action: string });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(okAgentResult("start", true)),
      });
    },
  );

  await page.goto("/orchestration");
  await expect(page.getByRole("button", { name: "Start agent" })).toBeEnabled();
  await page.getByRole("button", { name: "Start agent" }).click();

  await expect(async () => expect(captured).toContainEqual({ action: "start" })).toPass();
});

test("Reload agent POSTs { action: 'restart' } to /watchdog/agent", async ({ page }) => {
  await stubWatchdog(page, baseSnap({ launchd: { exists: true, loaded: true, intervalSeconds: 300 } }));

  const captured: { action: string }[] = [];
  await page.route(
    (url) => url.pathname === "/api/orchestration/watchdog/agent",
    async (route) => {
      captured.push(route.request().postDataJSON() as { action: string });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(okAgentResult("restart", true)),
      });
    },
  );

  await page.goto("/orchestration");
  await page.getByRole("button", { name: "Reload agent" }).click();

  await expect(async () => expect(captured).toContainEqual({ action: "restart" })).toPass();
});

test("Stop agent POSTs { action: 'stop' } to /watchdog/agent", async ({ page }) => {
  await stubWatchdog(page, baseSnap({ launchd: { exists: true, loaded: true, intervalSeconds: 300 } }));

  const captured: { action: string }[] = [];
  await page.route(
    (url) => url.pathname === "/api/orchestration/watchdog/agent",
    async (route) => {
      captured.push(route.request().postDataJSON() as { action: string });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(okAgentResult("stop", false)),
      });
    },
  );

  await page.goto("/orchestration");
  await expect(page.getByRole("button", { name: "Stop agent" })).toBeEnabled();
  await page.getByRole("button", { name: "Stop agent" }).click();

  await expect(async () => expect(captured).toContainEqual({ action: "stop" })).toPass();
});

// ─── Next-run label variants ──────────────────────────────────────────────────

test("shows '— (watchdog paused)' when config.enabled is false", async ({ page }) => {
  await stubWatchdog(
    page,
    baseSnap({ config: { enabled: false, jobs: 2, extra: {} }, launchd: { exists: true, loaded: true, intervalSeconds: 300 } }),
  );

  await page.goto("/orchestration");

  // ControlBar badge — use exact: true to avoid matching "— (watchdog paused)" in the Next run label.
  await expect(page.getByText("Watchdog paused", { exact: true })).toBeVisible();
  // ScheduleCard next-run label.
  await expect(page.getByText("— (watchdog paused)")).toBeVisible();
  // ControlBar shows "Resume watchdog" (not "Pause watchdog").
  await expect(page.getByRole("button", { name: "Resume watchdog" })).toBeVisible();
});

test("shows 'paused — resumes …' when resumeAt is a future time", async ({ page }) => {
  const resumeDate = new Date(Date.now() + 4 * 3600 * 1000); // 4 h from now
  await stubWatchdog(
    page,
    baseSnap({
      config: {
        enabled: true,
        jobs: 2,
        extra: {},
        resumeAt: Math.floor(resumeDate.getTime() / 1000),
      },
      resumeAt: resumeDate.toISOString(),
    }),
  );

  await page.goto("/orchestration");

  // Next-run label starts with "paused — resumes".
  await expect(page.getByText(/^paused — resumes/)).toBeVisible();
  // The "Clear" button appears since resumeAt is set.
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
});

test("shows 'next tick in …' when loaded, enabled, and nextRunAt is in the future", async ({ page }) => {
  const nextRun = new Date(Date.now() + 90 * 1000); // 90 s from now → "1m 30s" or similar
  await stubWatchdog(
    page,
    baseSnap({
      launchd: { exists: true, loaded: true, intervalSeconds: 300 },
      nextRunAt: nextRun.toISOString(),
    }),
  );

  await page.goto("/orchestration");

  await expect(page.getByText(/next tick in/)).toBeVisible();
});

// ─── Last tick display ────────────────────────────────────────────────────────

test("shows last-tick time and duration when lastRun is present", async ({ page }) => {
  const lastRunAt = new Date(Date.now() - 60 * 1000); // 60 s ago
  await stubWatchdog(
    page,
    baseSnap({
      lastRun: { startedAt: lastRunAt.toISOString(), durationMs: 420, result: "idle" },
      launchd: { exists: true, loaded: true, intervalSeconds: 300 },
    }),
  );

  await page.goto("/orchestration");

  // "took 420ms" is rendered by fmtTickDuration (420 < 1000 → "${ms}ms").
  await expect(page.getByText(/took 420ms/)).toBeVisible();

  // The tick "result" appears after the duration.
  await expect(page.getByText(/idle/)).toBeVisible();
});

test("shows 'no tick recorded yet' when lastRun is absent", async ({ page }) => {
  await stubWatchdog(page, baseSnap({ launchd: { exists: true, loaded: true } }));

  await page.goto("/orchestration");

  await expect(page.getByText("no tick recorded yet")).toBeVisible();
});

// ─── RESUME_AT presets and Clear ─────────────────────────────────────────────

test("clicking +1h preset POSTs enabled:true and a resumeAt ~1h from now", async ({ page }) => {
  await stubWatchdog(page, baseSnap());

  const captured: object[] = [];
  await page.route(
    (url) => url.pathname === "/api/orchestration/watchdog/config",
    async (route) => {
      captured.push(route.request().postDataJSON() as object);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(BASE_PATCH_OK) });
    },
  );

  await page.goto("/orchestration");

  const before = Math.floor(Date.now() / 1000);
  await page.getByRole("button", { name: "+1h" }).click();
  const after = Math.floor(Date.now() / 1000);

  await expect(async () => {
    expect(captured.length).toBeGreaterThan(0);
    const body = captured[0] as { enabled: boolean; resumeAt: number };
    expect(body.enabled).toBe(true);
    // resumeAt should be ~3600 s from now (allow ±120 s of test slop).
    expect(body.resumeAt).toBeGreaterThanOrEqual(before + 3600 - 120);
    expect(body.resumeAt).toBeLessThanOrEqual(after + 3600 + 120);
  }).toPass();
});

test("Clear button POSTs { resumeAt: 0 } to clear the schedule", async ({ page }) => {
  const resumeDate = new Date(Date.now() + 2 * 3600 * 1000);
  await stubWatchdog(
    page,
    baseSnap({
      config: {
        enabled: true,
        jobs: 2,
        extra: {},
        resumeAt: Math.floor(resumeDate.getTime() / 1000),
      },
      resumeAt: resumeDate.toISOString(),
    }),
  );

  const captured: object[] = [];
  await page.route(
    (url) => url.pathname === "/api/orchestration/watchdog/config",
    async (route) => {
      captured.push(route.request().postDataJSON() as object);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(BASE_PATCH_OK) });
    },
  );

  await page.goto("/orchestration");

  // "Clear" button is present because resumeAt is set.
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();

  await expect(async () =>
    expect(captured).toContainEqual(expect.objectContaining({ resumeAt: 0 })),
  ).toPass();
});
