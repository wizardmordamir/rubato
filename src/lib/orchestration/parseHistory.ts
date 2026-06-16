/**
 * Pure parser for the durable history archive (`Tasks_Completed.md`): each `##`
 * section is one completed task with a `- Started: <ISO> · Completed: <ISO> ·
 * Duration: <Nm Ns>` line and (usually) a "Landed <repo> <commit>" line.
 *
 * No I/O — pure string → {@link HistoryEntry}[] — so it lives in the library layer
 * and is unit-tested directly. The file read lives in `src/server/orchestration.ts`.
 */

import type { HistoryEntry } from '../../shared/orchestration';

// `## <title>` — any second-level heading starts a completed-task section.
const HEADING_RE = /^##\s+(.*)$/;
// `- Started: <iso> · Completed: <iso> · Duration: <text>` (fields independently optional).
const STARTED_RE = /Started:\s*([^\s·]+)/i;
const COMPLETED_RE = /Completed:\s*([^\s·]+)/i;
const DURATION_RE = /Duration:\s*([^·\n]+)/i;
// "Landed rubato main 0d06956", "Landed cwip master 39f3809 + rubato main 0a2d380", etc.
const LANDED_RE = /Landed\s+([a-z0-9._-]+)\b[^\n]*?\b([0-9a-f]{7,40})\b/i;

/**
 * Parse a human duration string to seconds. Handles `46m 32s`, `9m`, `8m 14s`,
 * `~9m` (approximate), `1h 5m`, `90s`. Returns `undefined` when nothing parses.
 */
export function parseDurationSeconds(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/~/g, '').trim();
  let seconds = 0;
  let matched = false;
  for (const m of cleaned.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/gi)) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    seconds += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
  }
  return matched ? Math.round(seconds) : undefined;
}

/** Strip a trailing ` — Claude`/` — <author>` suffix from a section title. */
function cleanTitle(raw: string): string {
  return raw.replace(/\s+[—-]\s+\S+\s*$/u, (m) => (/—|–/.test(m) ? '' : m)).trim() || raw.trim();
}

/**
 * Parse the whole Tasks_Completed.md text into {@link HistoryEntry}[] in file
 * order. Each `## …` heading begins a section; its first metadata line supplies
 * start/end/duration and a Landed line supplies repo + commit. A section without
 * a Started line is still included (title-only), so manual edits don't vanish.
 */
export function parseHistory(markdown: string): HistoryEntry[] {
  const lines = markdown.split('\n');
  const entries: HistoryEntry[] = [];

  let current: HistoryEntry | null = null;
  let body: string[] = [];

  const finalize = () => {
    if (!current) return;
    const text = body.join('\n');
    const started = text.match(STARTED_RE);
    const completed = text.match(COMPLETED_RE);
    const duration = text.match(DURATION_RE);
    const landed = text.match(LANDED_RE);
    if (started) current.start = started[1].trim();
    if (completed) current.end = completed[1].trim();
    if (duration) {
      current.durationText = duration[1].trim();
      current.durationSeconds = parseDurationSeconds(current.durationText);
    }
    if (landed) {
      current.repo = landed[1].trim();
      current.commit = landed[2].trim();
    }
    entries.push(current);
  };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m) {
      finalize();
      const title = cleanTitle(m[1]);
      // Skip the file's own intro heading-less prose; only `##` sections count.
      current = { title, line: i + 1 };
      body = [];
      continue;
    }
    if (current) body.push(lines[i]);
  }
  finalize();

  return entries;
}
