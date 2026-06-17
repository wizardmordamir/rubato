/**
 * Pure, surgical transforms over the `TASKS.md` text — insert / replace / delete a
 * single task block — for the Orchestration "Tasks" builder. No I/O: string in,
 * string out, so it's unit-tested directly and the locked file write lives in
 * `src/server/orchestration.ts`.
 *
 * Why surgical (not whole-file overwrite): the unattended drainer + its workers
 * edit `TASKS.md` concurrently (flipping `[ ]`→`[~]`, deleting finished entries).
 * The server re-reads the file fresh under a lock and applies one of these
 * minimal edits, so a builder save never clobbers a worker's claim that landed
 * between page-load and save — only the targeted task's lines change.
 *
 * A "task block" is its `## [tag] …` heading plus the detail lines beneath it, up
 * to (but not including) the next task heading, any markdown heading, a `---`
 * rule, or an HTML `<!--` section banner (the file groups tasks under banners —
 * an edit must never swallow the following banner). Trailing blank lines are not
 * part of the block.
 */

/** The anchor task (matched by its verbatim heading) was not found — it was
 *  claimed, edited, or completed by a worker since the page loaded. The caller
 *  surfaces this as a 409 so the UI refreshes rather than clobbering live state. */
export class TaskConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskConflictError';
  }
}

/** A `## [tag] …` task heading (any status char). */
const TASK_HEADING_RE = /^##\s+\[.\]/;
/** A block boundary: any markdown heading, a `---` rule, or a `<!--` banner. */
const BOUNDARY_RE = /^(?:#{1,6}\s|---\s*$|\s*<!--)/;

function isTaskHeading(line: string): boolean {
  return TASK_HEADING_RE.test(line);
}

function isBoundary(line: string): boolean {
  return BOUNDARY_RE.test(line);
}

/** Index of the first task heading, or -1 when the file has no tasks yet. */
function firstTaskHeadingIndex(lines: string[]): number {
  return lines.findIndex(isTaskHeading);
}

/** Index of the line whose trimmed text equals `anchorHeading` and is a task
 *  heading; -1 if absent. */
function findTaskStart(lines: string[], anchorHeading: string): number {
  const target = anchorHeading.trim();
  for (let i = 0; i < lines.length; i++) {
    if (isTaskHeading(lines[i]) && lines[i].trim() === target) return i;
  }
  return -1;
}

/** Exclusive end index of the block starting at `headingIdx`, excluding any
 *  trailing blank lines. */
function blockEnd(lines: string[], headingIdx: number): number {
  let i = headingIdx + 1;
  while (i < lines.length && !isBoundary(lines[i])) i++;
  // Trim trailing blank lines back out of the block (they're separators).
  while (i > headingIdx + 1 && lines[i - 1].trim() === '') i--;
  return i;
}

/** Drop blank lines off the end of `before` / start of `after`, then re-join with
 *  exactly one blank line between non-empty neighbours (keeps the file tidy after
 *  an insert/delete). */
function joinSections(before: string[], middle: string[], after: string[]): string[] {
  const b = [...before];
  while (b.length && b[b.length - 1].trim() === '') b.pop();
  const a = [...after];
  while (a.length && a[0].trim() === '') a.shift();
  const out: string[] = [];
  if (b.length) out.push(...b, '');
  out.push(...middle);
  if (a.length) out.push('', ...a);
  return out;
}

/** Split into lines while remembering a trailing newline, so transforms preserve
 *  the file's final-newline convention. */
function splitKeepingEol(markdown: string): { lines: string[]; eol: string } {
  const eol = markdown.endsWith('\n') ? '\n' : '';
  return { lines: (eol ? markdown.slice(0, -1) : markdown).split('\n'), eol };
}

/** Where a new task goes relative to existing tasks. */
export type InsertAt = 'top' | 'bottom' | 'before' | 'after';

/**
 * Insert `block` into the file. `top` lands it above the first task (priority
 * order — top is highest); `bottom` appends; `before`/`after` position it
 * relative to the task whose heading is `anchorHeading`. Throws
 * {@link TaskConflictError} if a `before`/`after` anchor is gone.
 */
export function insertTaskBlock(markdown: string, block: string, at: InsertAt, anchorHeading?: string): string {
  const { lines, eol } = splitKeepingEol(markdown);
  const blockLines = block.split('\n');

  let insertAt: number;
  if (at === 'top') {
    const first = firstTaskHeadingIndex(lines);
    insertAt = first < 0 ? lines.length : first;
  } else if (at === 'bottom') {
    insertAt = lines.length;
  } else {
    if (!anchorHeading) throw new TaskConflictError(`'${at}' requires an anchor task`);
    const idx = findTaskStart(lines, anchorHeading);
    if (idx < 0) throw new TaskConflictError(`anchor task no longer in TASKS.md: ${anchorHeading}`);
    insertAt = at === 'before' ? idx : blockEnd(lines, idx);
  }

  const merged = joinSections(lines.slice(0, insertAt), blockLines, lines.slice(insertAt));
  return merged.join('\n') + eol;
}

/**
 * Replace the task whose heading is `anchorHeading` with `block` (heading + body).
 * Surrounding blank-line spacing is left untouched (minimal diff). Throws
 * {@link TaskConflictError} if the anchor is gone (it was claimed/edited).
 */
export function replaceTaskBlock(markdown: string, anchorHeading: string, block: string): string {
  const { lines, eol } = splitKeepingEol(markdown);
  const start = findTaskStart(lines, anchorHeading);
  if (start < 0) throw new TaskConflictError(`task no longer in TASKS.md (it may have been claimed): ${anchorHeading}`);
  const end = blockEnd(lines, start);
  const blockLines = block.split('\n');
  return [...lines.slice(0, start), ...blockLines, ...lines.slice(end)].join('\n') + eol;
}

/**
 * Delete the task whose heading is `anchorHeading`, collapsing the surrounding
 * blank lines to a single separator. Throws {@link TaskConflictError} if absent.
 */
export function deleteTaskBlock(markdown: string, anchorHeading: string): string {
  const { lines, eol } = splitKeepingEol(markdown);
  const start = findTaskStart(lines, anchorHeading);
  if (start < 0) throw new TaskConflictError(`task no longer in TASKS.md (it may have been claimed): ${anchorHeading}`);
  let end = blockEnd(lines, start);
  // Consume trailing blank separators so two tasks don't end up double-spaced.
  while (end < lines.length && lines[end].trim() === '') end++;
  const merged = joinSections(lines.slice(0, start), [], lines.slice(end));
  return merged.join('\n') + eol;
}
