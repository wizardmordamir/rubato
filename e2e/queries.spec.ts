import { expect, test } from "@playwright/test";

/**
 * Queries page (query builder) against the real server: connection + saved-query
 * CRUD round-trips through the live API, execution is credential-gated (412 with
 * the env var named), and — after enabling the page toggle — the UI renders the
 * builder and reflects a created connection.
 */

const CONN = {
  name: "e2e pg",
  dialect: "postgres",
  host: "db.example.com",
  port: 5432,
  database: "app",
  username: "reader",
  ssl: false,
  envKey: "E2EPG",
  collections: ["users"],
  allowWrites: false,
};

test("connection CRUD + credential-gated run through the live API", async ({ request }) => {
  // Create — no password field exists; status says which env vars would enable runs.
  const created = await (await request.post("/api/db-connections", { data: CONN })).json();
  expect(created.id).toBeTruthy();
  expect(created.hasCredentials).toBe(false);
  expect(created.expectedEnv).toEqual(["QB_E2EPG_PASSWORD", "QB_E2EPG_URL"]);

  // Run without credentials → 412 naming the env var.
  const run = await request.post(`/api/db-connections/${created.id}/run`, { data: { query: "SELECT 1" } });
  expect(run.status()).toBe(412);
  const body = await run.json();
  expect(body.ok).toBe(false);
  expect(body.error.message).toContain("QB_E2EPG_PASSWORD");

  // Saved query round-trip.
  const saved = await (
    await request.post("/api/db-queries", {
      data: {
        name: "all users",
        connectionId: created.id,
        dialect: "postgres",
        kind: "sql",
        collection: "users",
        spec: { table: "users" },
        queryText: "SELECT * FROM users",
      },
    })
  ).json();
  expect(saved.id).toBeTruthy();
  const list = await (await request.get("/api/db-queries")).json();
  expect(list.some((q: { id: string }) => q.id === saved.id)).toBe(true);

  // Cleanup.
  expect((await (await request.delete(`/api/db-queries/${saved.id}`)).json()).deleted).toBe(true);
  expect((await (await request.delete(`/api/db-connections/${created.id}`)).json()).deleted).toBe(true);
});

test("the Queries page renders and lists a created connection", async ({ page, request }) => {
  // The page ships toggled off; enable it like a user would via the config API.
  await request.post("/api/ui", { data: { pages: { queries: true } } });
  const created = await (await request.post("/api/db-connections", { data: { ...CONN, name: "ui pg" } })).json();

  await page.goto("/queries");
  await expect(page.getByRole("heading", { name: "Queries", exact: true })).toBeVisible();
  // The created connection is selectable and its credential status is surfaced.
  await expect(page.locator("select").first()).toContainText("ui pg (postgres)");
  await expect(page.getByText(/no creds — set QB_E2EPG_PASSWORD/)).toBeVisible();

  await request.delete(`/api/db-connections/${created.id}`);
});
