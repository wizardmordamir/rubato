import { type APIRequestContext, expect, test } from "@playwright/test";

/**
 * Vault page e2e coverage: unlock / lock, item CRUD (add / edit / delete),
 * wrong-password error, and API-seeded items appearing after unlock.
 *
 * The vault master cannot be unset via the API, so `beforeAll` sets it
 * idempotently (409 = already set) and all tests unlock with the known password.
 * Items are cleaned up before each test so state is predictable across reruns
 * (when `reuseExistingServer` keeps the same DB between local runs).
 */

const VAULT_PW = "e2e-vault-pw-99";

/** Unlock the vault via API and return the short-lived token. */
async function apiUnlock(request: APIRequestContext): Promise<string> {
  const { token } = (await (
    await request.post("/api/vault/unlock", { data: { masterPassword: VAULT_PW } })
  ).json()) as { token: string };
  return token;
}

/** Delete all vault items via the API (requires an unlock token). */
async function cleanupItems(request: APIRequestContext): Promise<void> {
  const token = await apiUnlock(request);
  const items = (await (
    await request.get("/api/vault/items", { headers: { "x-vault-token": token } })
  ).json()) as Array<{ id: string }>;
  for (const { id } of items) await request.delete(`/api/vault/items/${id}`);
}

test.beforeAll(async ({ request }) => {
  // Enable vault page once per suite.
  await request.post("/api/ui", { data: { pages: { vault: true } } });
  // Ensure the vault master is set. 409 = already set (e.g. server reuse) — that's fine.
  const res = await request.post("/api/vault/master", { data: { masterPassword: VAULT_PW } });
  if (!res.ok() && res.status() !== 409) throw new Error(`Failed to init vault master: ${res.status()}`);
});

test.beforeEach(async ({ request }) => {
  // Start each test with no items so assertions are unambiguous.
  await cleanupItems(request);
});

// ── Unlock, full item CRUD (add / edit / delete), lock, re-unlock ─────────────

test("unlock vault, add / edit / delete an item, lock and unlock", async ({ page }) => {
  await page.goto("/vault");
  await expect(page.getByRole("heading", { name: /^Vault/ })).toBeVisible();

  // Vault is always locked on page load (token is in-memory only).
  await expect(page.getByRole("heading", { level: 2, name: /Vault locked/i })).toBeVisible();

  // Unlock with the correct master password.
  await page.getByPlaceholder("vault password").fill(VAULT_PW);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText(/Your vault is empty/i)).toBeVisible();

  // Add an item: header button → editor modal → save.
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByPlaceholder("e.g. Chase Bank").fill("E2E Vault Site");
  await page.getByPlaceholder("username / email").fill("vaultuser@example.com");
  await page.locator('input[placeholder="password"]').fill("hunter2");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // Item card is visible with title and username.
  await expect(page.getByText("E2E Vault Site")).toBeVisible();
  await expect(page.getByText("vaultuser@example.com")).toBeVisible();

  // Edit: open editor, change the title, save.
  await page.getByRole("button", { name: "Edit" }).click();
  const titleField = page.getByPlaceholder("e.g. Chase Bank");
  await titleField.clear();
  await titleField.fill("E2E Vault Site (edited)");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("E2E Vault Site (edited)")).toBeVisible();

  // Delete: trash button → confirm dialog → confirm.
  await page.getByRole("button", { name: "Delete item" }).click();
  await expect(page.getByText(/Delete "E2E Vault Site \(edited\)"\?/)).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();

  // List is empty again.
  await expect(page.getByText(/Your vault is empty/i)).toBeVisible();

  // Lock via header button.
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Vault locked/i })).toBeVisible();

  // Unlock again to confirm the password still works.
  await page.getByPlaceholder("vault password").fill(VAULT_PW);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText(/Your vault is empty/i)).toBeVisible();
});

// ── Wrong password shows an inline error ─────────────────────────────────────

test("wrong vault password shows an error", async ({ page }) => {
  await page.goto("/vault");
  await expect(page.getByRole("heading", { level: 2, name: /Vault locked/i })).toBeVisible();

  await page.getByPlaceholder("vault password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Unlock" }).click();

  await expect(page.getByText(/Incorrect vault password/i)).toBeVisible();
  // Vault stays locked after a bad password.
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
});

// ── Item seeded via API is visible after unlock ───────────────────────────────

test("item created via API appears in the list after unlock", async ({ page, request }) => {
  const token = await apiUnlock(request);
  const { id } = (await (
    await request.post("/api/vault/items", {
      data: { title: "API-seeded cred", username: "api-user" },
      headers: { "x-vault-token": token },
    })
  ).json()) as { id: string };

  await page.goto("/vault");
  // Unlock in the UI.
  await page.getByPlaceholder("vault password").fill(VAULT_PW);
  await page.getByRole("button", { name: "Unlock" }).click();

  // The API-created item is visible.
  await expect(page.getByText("API-seeded cred")).toBeVisible();
  await expect(page.getByText("api-user")).toBeVisible();

  // Clean up.
  await request.delete(`/api/vault/items/${id}`);
});
