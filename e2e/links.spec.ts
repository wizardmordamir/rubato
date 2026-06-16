import { expect, test } from "@playwright/test";

/**
 * Links page: enable the toggle, add a link through the editor modal, see it in
 * the list, filter it out with a non-matching search, then import a bookmarks
 * export through the API and watch the imported link appear on refetch.
 */

test("add a link, search it away, then import bookmarks", async ({ page, request }) => {
  await request.post("/api/ui", { data: { pages: { links: true } } });

  await page.goto("/links");
  await expect(page.getByRole("heading", { name: /^Links/ })).toBeVisible();

  // Add a link via the header button → editor modal.
  await page.getByRole("button", { name: "Add link" }).click();
  await page.getByPlaceholder(/^https/).fill("https://example.com/e2e-link");
  await page.getByPlaceholder("Title").fill("E2E Saved Link");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect(page.getByText("E2E Saved Link")).toBeVisible();

  // A non-matching search hides every card.
  await page.getByPlaceholder("Search links…").fill("zzz-no-such-link");
  await expect(page.getByText("No links match your search.")).toBeVisible();
  await page.getByPlaceholder("Search links…").fill("");

  // Import a bookmarks export through the API; the imported link shows on refetch.
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><A HREF="https://example.com/imported-bookmark">Imported Bookmark</A>
</DL><p>`;
  const result = (await (await request.post("/api/links/import", { data: { html } })).json()) as {
    imported: number;
  };
  expect(result.imported).toBe(1);

  await page.reload();
  await expect(page.getByText("Imported Bookmark")).toBeVisible();

  // Clean up both links via the API.
  const links = (await (await request.get("/api/links")).json()) as Array<{ id: string }>;
  for (const l of links) await request.delete(`/api/links/${l.id}`);
});
