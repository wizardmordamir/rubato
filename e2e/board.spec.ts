import { expect, test } from "@playwright/test";

/**
 * Board page: enable the toggle, create a task through the editor modal, see
 * it land in its column, then move it via the API and watch the UI re-group.
 */

test("create a task in Ready, then it shows under In progress after a move", async ({ page, request }) => {
  await request.post("/api/ui", { data: { pages: { board: true } } });

  await page.goto("/board");
  await expect(page.getByRole("heading", { name: /^Board/ })).toBeVisible();

  // Create via the Ready column's "+".
  await page.getByRole("button", { name: "Add to Ready" }).click();
  await page.getByPlaceholder("title").fill("e2e card");
  await page.getByPlaceholder("links (one per line)").fill("https://example.com/x");
  await page.getByRole("button", { name: "Create" }).click();

  const ready = page.getByRole("region", { name: "Ready" });
  await expect(ready.getByText("e2e card")).toBeVisible();
  await expect(ready.getByText("1 link(s)")).toBeVisible();

  // Move it via the API (drag-drop itself is simulated at the API layer; the
  // UI re-groups by status on refetch).
  const tasks = (await (await request.get("/api/board")).json()) as Array<{ id: string; title: string }>;
  const card = tasks.find((t) => t.title === "e2e card");
  expect(card).toBeTruthy();
  await request.post("/api/board", { data: { ...tasks.find((t) => t.title === "e2e card"), status: "in-progress" } });

  await page.reload();
  await expect(page.getByRole("region", { name: "In progress" }).getByText("e2e card")).toBeVisible();

  await request.delete(`/api/board/${card?.id}`);
});
