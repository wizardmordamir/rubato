import { expect, test } from "@playwright/test";

/**
 * Smoke suite: proves a worktree can boot the real server and serve the UI. The
 * webServer in playwright.config.ts starts `rubato-serve` against a throwaway
 * RUBATO_HOME, so this runs against an empty registry — no real data required.
 */

test("GET /api/health reports ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.ok).toBe(true);
  // `commands` is the registry size — always > 0 — so this also asserts the
  // server wired the command registry, not just that the port is listening.
  expect(body.commands).toBeGreaterThan(0);
});

test("the explorer UI loads at /", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Rubato");
  // Both the built React app and the no-build fallback render an "rubato"
  // heading, so this holds whether or not `bun run web:build` has run.
  await expect(page.getByText(/rubato/i).first()).toBeVisible();
});

test("GET /api/apps serves the seeded registry", async ({ request }) => {
  // global-setup seeded the throwaway home via provisionSandbox.
  const res = await request.get("/api/apps");
  expect(res.ok()).toBe(true);
  const names = ((await res.json()) as Array<{ name: string }>).map((a) => a.name);
  expect(names).toEqual(expect.arrayContaining(["api", "web", "cli"]));
});
