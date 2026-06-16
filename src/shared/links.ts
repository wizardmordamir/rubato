/**
 * Wire types for the Links page — a per-machine, searchable catalogue of URLs.
 * Add by hand (title/url/description/folder/tags/notes) or import a browser
 * bookmarks export (Chrome/Edge/Firefox/Safari `bookmarks.html`, parsed by
 * cwip's `parseBookmarksHtml`). `url` is UNIQUE, so re-importing dedupes.
 *
 * Single-user + local, so there's no owner/sharing — the cursedalchemy sibling
 * (`/links`) is the same feature with per-user scoping on top.
 */

/** A saved link, as the UI receives it (tags parsed from their JSON column). */
export interface LinkItem {
  id: string;
  url: string;
  title: string;
  description: string;
  notes: string;
  tags: string[];
  folder: string;
  /** Favicon data URI, when an import carried one (`''` otherwise). */
  favicon: string;
  createdAt: number;
  updatedAt: number;
}

/** The editable fields a create/update accepts (`url` required only on create). */
export interface LinkItemInput {
  url?: string;
  title?: string;
  description?: string;
  notes?: string;
  tags?: string[];
  folder?: string;
}

/** Outcome of a bookmarks-HTML import: how many rows were added vs. skipped. */
export interface LinkImportResult {
  imported: number;
  skipped: number;
  total: number;
}

/**
 * Trim, drop blanks, de-dupe (case-insensitive), and cap a tag list — the one
 * place tag hygiene lives, shared by the server (on write) and the UI (when
 * splitting the comma field), so both agree. Pure, so it stays import-clean.
 */
export function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const trimmed = t.trim().slice(0, 40);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 30) break;
  }
  return out;
}
