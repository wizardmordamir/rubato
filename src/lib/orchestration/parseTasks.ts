/**
 * Pure parser for the live task board (`TASKS.md`): turn its `##`-heading markdown
 * into structured {@link WorkflowTask}s grouped by status.
 *
 * The board uses a status tag on each `##` heading, flipped in place rather than
 * moved between files:
 *   - `## [ ] …`                                           ready
 *   - `## [~] (worktree: <slug> · <ISO>) …`                claimed / in progress
 *   - `## [x] (<ISO> → <ISO> · <dur> · <repo> <commit>) …` done
 *   - `## [!] (<reason>) …`                                blocked
 *   - `## [-] …`                                           not ready
 *
 * No I/O here (pure string → model), so this lives in the library layer and is
 * unit-tested directly; the file read happens in `src/server/orchestration.ts`.
 */

import type { WorkflowBoard, WorkflowTask, WorkflowTaskMeta, WorkflowTaskStatus } from '../../shared/orchestration';
import { WORKFLOW_STATUSES } from '../../shared/orchestration';

/** Map a `[?]` tag character to a status (`undefined` for a non-task heading). */
function statusForTag(tag: string): WorkflowTaskStatus | undefined {
  switch (tag) {
    case ' ':
      return 'ready';
    case '~':
      return 'claimed';
    case 'x':
    case 'X':
      return 'done';
    case '!':
      return 'blocked';
    case '-':
      return 'not-ready';
    default:
      return undefined;
  }
}

// `## [x] rest…` — the tag is exactly one char between brackets right after `## `.
const HEADING_RE = /^##\s+\[(.)\]\s*(.*)$/;
// A leading `(...)` metadata group, captured non-greedily so nested `·` is fine.
const LEADING_PAREN_RE = /^\(([^)]*)\)\s*/;
// Short commit hashes look like 7–40 hex chars (git short/long).
const COMMIT_RE = /\b([0-9a-f]{7,40})\b/;

/**
 * Pull the structured fields out of a heading's leading `(...)` group(s), given the
 * task status (different statuses stamp different fields). A claimed heading can
 * carry SEVERAL leading groups — e.g. `(resume: <slug>) (worktree: <slug> · <ISO>)`
 * or `(recur:N) (worktree: …)` — so the caller passes them all joined; we scan the
 * whole thing. Defensive: any field that isn't present is simply omitted.
 */
function parseMeta(status: WorkflowTaskStatus, paren: string): WorkflowTaskMeta {
  const meta: WorkflowTaskMeta = {};
  const inner = paren.trim();
  if (!inner) return meta;

  // `worktree: <slug>` (claimed).
  const wt = inner.match(/worktree:\s*([^·)]+)/i);
  if (wt) meta.worktree = wt[1].trim();

  // `resume: <slug>` — the watchdog re-opens a stranded claim with this marker.
  const res = inner.match(/resume:\s*([^·)\s]+)/i);
  if (res) meta.resume = res[1].trim();

  // ISO timestamps — first is start, a second (after `→`) is end.
  const isoMatches = inner.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?|\bT[\d:.]+Z?\b/g) ?? [];
  if (isoMatches[0]) meta.start = isoMatches[0].trim();
  if (isoMatches[1]) meta.end = isoMatches[1].trim();

  if (status === 'done') {
    // Duration: the `· <dur> ·` segment between the timestamps and repo/commit.
    const dur = inner.match(/·\s*(~?\d+\s*m(?:\s*\d+\s*s)?|~?\d+\s*s|~?\d+\s*h[^·]*)/i);
    if (dur) meta.duration = dur[1].trim();
    // Repo + commit: the trailing `· <repo> <commit>` segment.
    const tail = inner.split('·').pop()?.trim() ?? '';
    const commit = tail.match(COMMIT_RE);
    if (commit) {
      meta.commit = commit[1];
      const repo = tail.slice(0, commit.index).trim();
      if (repo) meta.repo = repo;
    } else if (tail && !/\d{4}-\d{2}-\d{2}/.test(tail)) {
      meta.repo = tail;
    }
  }

  if (status === 'blocked') meta.reason = inner;

  // Per-task model/thinking overrides — present on any status (the drainer
  // preserves them when it stamps a `[~]` claim). Match `(model:<id>)` and
  // `(think:<level>)` markers anywhere in the heading's paren groups.
  const modelM = inner.match(/\bmodel:\s*([^\s)]+)/i);
  if (modelM) meta.model = modelM[1].trim();
  const thinkM = inner.match(/\bthink(?:ing(?:level|Level)?)?:\s*([^\s)]+)/i);
  if (thinkM) meta.thinkingLevel = thinkM[1].trim().toLowerCase();

  return meta;
}

/**
 * Strip EVERY leading `(...)` metadata group from a title, returning the bare title
 * plus the groups' inner text joined by a space. A claimed heading often carries
 * more than one group — `(resume: <slug>) (worktree: <slug> · <ISO>)` — and a
 * single-group strip would leave the `(worktree: …)` marker in the title and miss
 * the start time entirely (the dashboard's "no start/duration" bug).
 */
function stripLeadingParen(rest: string): { paren: string; title: string } {
  const groups: string[] = [];
  let title = rest;
  let m = title.match(LEADING_PAREN_RE);
  while (m) {
    groups.push(m[1]);
    title = title.slice(m[0].length);
    m = title.match(LEADING_PAREN_RE);
  }
  return { paren: groups.join(' '), title: title.trim() };
}

/**
 * Parse the whole TASKS.md text into a {@link WorkflowBoard}. Only `##` headings that
 * carry a recognized status tag become tasks; prose, the protocol section, and
 * the file's own headers/separators are ignored. A heading's body is every line
 * up to the next `##`/`#` heading or the next `---` separator.
 */
export function parseTaskBoard(markdown: string): WorkflowBoard {
  const lines = markdown.split('\n');
  const tasks: WorkflowTask[] = [];

  let current: WorkflowTask | null = null;
  const bodyLines: string[] = [];

  const flush = () => {
    if (current) {
      current.body = bodyLines.join('\n').trim();
      tasks.push(current);
    }
    current = null;
    bodyLines.length = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(HEADING_RE);
    const status = heading ? statusForTag(heading[1]) : undefined;

    if (heading && status) {
      flush();
      const { paren, title } = stripLeadingParen(heading[2]);
      current = {
        status,
        title: title || heading[2].trim(),
        rawHeading: line,
        meta: parseMeta(status, paren),
        body: '',
        line: i + 1,
      };
      continue;
    }

    // Any other heading (`#`, an unrecognized `##`) or a `---` rule ends the body.
    if (/^#{1,6}\s/.test(line) || /^---\s*$/.test(line)) {
      flush();
      continue;
    }
    if (current) bodyLines.push(line);
  }
  flush();

  const groups = Object.fromEntries(WORKFLOW_STATUSES.map((s) => [s, [] as WorkflowTask[]])) as Record<
    WorkflowTaskStatus,
    WorkflowTask[]
  >;
  for (const t of tasks) groups[t.status].push(t);
  const counts = Object.fromEntries(WORKFLOW_STATUSES.map((s) => [s, groups[s].length])) as Record<
    WorkflowTaskStatus,
    number
  >;

  return { tasks, groups, counts, total: tasks.length };
}

/** An empty board (used when TASKS.md is missing). */
export function emptyTaskBoard(): WorkflowBoard {
  const groups = Object.fromEntries(WORKFLOW_STATUSES.map((s) => [s, [] as WorkflowTask[]])) as Record<
    WorkflowTaskStatus,
    WorkflowTask[]
  >;
  const counts = Object.fromEntries(WORKFLOW_STATUSES.map((s) => [s, 0])) as Record<WorkflowTaskStatus, number>;
  return { tasks: [], groups, counts, total: 0 };
}
