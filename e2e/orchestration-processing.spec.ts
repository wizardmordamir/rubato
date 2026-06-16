import { expect, test } from "@playwright/test";

/**
 * Orchestration Processing — the timing-analytics API, end-to-end against the real
 * `rubato-serve` (empty throwaway RUBATO_HOME, so no real data is touched). Proves
 * the three endpoints are wired through `route()`: ingest (0 files in an empty home),
 * the aggregated GET (empty but well-shaped), and clear. The page-level rendering is
 * covered by the in-process server tests + the shared cwip chart components; this
 * keeps the e2e cheap (no UI nav, the page is opt-in/off by default).
 */

test("GET /api/orchestration/timings returns a well-shaped (empty) snapshot", async ({ request }) => {
  const res = await request.get("/api/orchestration/timings");
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body).toMatchObject({ total: 0 });
  expect(Array.isArray(body.stats)).toBe(true);
  expect(Array.isArray(body.trend)).toBe(true);
  expect(Array.isArray(body.sources)).toBe(true);
  expect(Array.isArray(body.repos)).toBe(true);
  expect(body.summary).toMatchObject({ eventCount: 0, totalMs: 0, taskCount: 0 });
  expect(typeof body.runsDir).toBe("string");
});

test("POST /api/orchestration/timings/ingest is safe with no source files", async ({ request }) => {
  const res = await request.post("/api/orchestration/timings/ingest", { data: {} });
  expect(res.ok()).toBe(true);
  // The throwaway home has no timing-*.jsonl → a clean zero result, not an error.
  expect(await res.json()).toEqual({ filesRead: 0, inserted: 0, skipped: 0 });
});

test("POST /api/orchestration/timings/clear reports a deleted count", async ({ request }) => {
  const res = await request.post("/api/orchestration/timings/clear", { data: {} });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(typeof body.deleted).toBe("number");
});
