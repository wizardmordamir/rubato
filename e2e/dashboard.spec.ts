import { expect, test } from "@playwright/test";

/**
 * Dashboard page: enable the toggle, then the page renders its summary stats and
 * the per-app status table (seeded sandbox repos appear).
 */
test("dashboard renders summary + per-app rows", async ({ page, request }) => {
  await request.post("/api/ui", { data: { pages: { dashboard: true } } });

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: /^Dashboard/ })).toBeVisible();

  // Summary stat cards (Apps + the percent-of-repos roll-ups).
  await expect(page.getByText("Git repos").first()).toBeVisible();
  // The seeded registry's apps show up in the table.
  await expect(page.getByText("api", { exact: true }).first()).toBeVisible();

  // A filter chip narrows the table without error.
  await page.getByRole("button", { name: "Git repos" }).click();
  await expect(page.getByRole("heading", { name: /^Dashboard/ })).toBeVisible();
});
