/**
 * Integration: the Links API through `route()` — link CRUD, presence-based patch,
 * the UNIQUE-url 409, and bookmarks-HTML import (folder mapping + dedupe).
 */

import { describe, expect, test } from 'bun:test';
import type { LinkImportResult, LinkItem } from '../../shared/links';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

async function fetchRoute(path: string, init?: RequestInit): Promise<Response> {
  const { route } = await import('../../server/router');
  return route(new Request(`http://localhost${path}`, init));
}

const LINK = {
  url: 'https://example.com/docs',
  title: 'Example docs',
  description: 'the docs',
  notes: 'read later',
  folder: 'Dev / Tools',
  tags: ['ref', 'Ref', ' docs '], // de-duped + trimmed by cleanTags
};

describe('links CRUD', () => {
  test('create → list → patch one field → delete', async () => {
    const created = (await (await apiPost('/api/links', LINK)).json()) as LinkItem;
    expect(created.id).toBeTruthy();
    expect(created.tags).toEqual(['ref', 'docs']); // case-insensitive de-dupe + trim
    expect(created.folder).toBe('Dev / Tools');

    const list = (await (await apiGet('/api/links')).json()) as LinkItem[];
    expect(list.some((l) => l.id === created.id)).toBe(true);

    // Presence-based patch: only `description` changes; tags/title are preserved.
    const patched = (await (
      await apiPost('/api/links', { id: created.id, description: 'updated' })
    ).json()) as LinkItem;
    expect(patched.id).toBe(created.id);
    expect(patched.description).toBe('updated');
    expect(patched.title).toBe('Example docs');
    expect(patched.tags).toEqual(['ref', 'docs']);

    const deleted = await (await fetchRoute(`/api/links/${created.id}`, { method: 'DELETE' })).json();
    expect(deleted).toEqual({ deleted: true });

    const after = (await (await apiGet('/api/links')).json()) as LinkItem[];
    expect(after.some((l) => l.id === created.id)).toBe(false);
  });

  test('defaults the title to the url, and 409s a duplicate url', async () => {
    const created = (await (await apiPost('/api/links', { url: 'https://dup.example.com' })).json()) as LinkItem;
    expect(created.title).toBe('https://dup.example.com');

    const dup = await apiPost('/api/links', { url: 'https://dup.example.com' });
    expect(dup.status).toBe(409);
  });

  test('rejects a create with no url, and a patch of a missing id', async () => {
    expect((await apiPost('/api/links', { title: 'no url' })).status).toBe(400);
    expect((await apiPost('/api/links', { id: 'nope', title: 'x' })).status).toBe(404);
  });
});

describe('bookmarks import', () => {
  const HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Dev</H3>
  <DL><p>
    <DT><A HREF="https://a.example.com">A site</A>
    <DT><A HREF="https://b.example.com">B site</A>
  </DL><p>
  <DT><A HREF="https://c.example.com">C top</A>
</DL><p>`;

  test('imports bookmarks with folder paths, then dedupes on re-import', async () => {
    const first = (await (await apiPost('/api/links/import', { html: HTML })).json()) as LinkImportResult;
    expect(first.imported).toBe(3);
    expect(first.skipped).toBe(0);
    expect(first.total).toBe(3);

    const list = (await (await apiGet('/api/links')).json()) as LinkItem[];
    const a = list.find((l) => l.url === 'https://a.example.com');
    expect(a?.folder).toBe('Dev');
    expect(a?.tags).toEqual(['imported']);

    // Re-importing the same export adds nothing (url is UNIQUE).
    const second = (await (await apiPost('/api/links/import', { html: HTML })).json()) as LinkImportResult;
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(3);
  });

  test('rejects an empty import body', async () => {
    expect((await apiPost('/api/links/import', { html: '   ' })).status).toBe(400);
  });
});
