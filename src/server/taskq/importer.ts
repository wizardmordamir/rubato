/**
 * One-time importer: legacy `TASKS.md` → the taskq SQLite queue. Reuses the
 * existing markdown parser (lib/orchestration), maps each entry's status +
 * markers to a taskq row, and inserts in priority order. Idempotent-ish: skips a
 * task whose `(id:)` slug already exists (or, slug-less, a same-title non-done
 * task), so a re-run won't duplicate. `claimed`/`done` entries are skipped
 * (runtime/history — not migrated).
 */

import { addTask, getTask, listTasks, MODEL_ALIASES, type NewTask, type TaskqDb, type TaskStatus, THINK_LEVELS } from 'cwip/taskq';
import { parseTaskBoard } from '../../lib/orchestration';
import type { WorkflowTask } from '../../shared/orchestration';

export interface ImportResult {
  imported: number;
  skipped: { title: string; reason: string }[];
}

/** Legacy `med` → `medium`; drop anything not a known level. */
function normThink(t: string | undefined): string | undefined {
  if (!t) return undefined;
  const v = t === 'med' ? 'medium' : t;
  return (THINK_LEVELS as string[]).includes(v) ? v : undefined;
}

function normModel(m: string | undefined): string | undefined {
  return m && (MODEL_ALIASES as readonly string[]).includes(m) ? m : undefined;
}

/** Map the legacy `[tag]` to a taskq status, or null to skip (runtime/history). */
function statusFor(task: WorkflowTask): TaskStatus | null {
  const tag = task.rawHeading.match(/^##\s+\[(.)\]/)?.[1] ?? ' ';
  switch (tag) {
    case ' ':
      return 'ready';
    case 'b':
    case 'B':
      return 'on_hold';
    case '!':
      return 'failed';
    case '-':
      return 'not_ready';
    default:
      return null; // [~] claimed, [x] done → skip
  }
}

/**
 * Trim a parsed task body at the first HTML `<!--` banner line. `parseTaskBoard`
 * ends a body only at the next heading/rule, so a task directly followed by a
 * `<!-- … -->` section banner swallows it — strip that (and trailing blanks).
 */
function cleanBody(body: string): string | undefined {
  const lines = body.split('\n');
  const cut = lines.findIndex((l) => l.trimStart().startsWith('<!--'));
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).join('\n').replace(/\s+$/, '');
  return kept || undefined;
}

/** Best-effort repo from a leading `ca `/`ru `/`cwip ` token in the title. */
function repoFor(title: string): string | undefined {
  const m = title.match(/^\s*(ca|ru|cwip)\b/i);
  return m ? m[1].toLowerCase() : undefined;
}

/** Import the markdown board into `db`. Returns counts + skip reasons. */
export function importTasksMd(db: TaskqDb, markdown: string): ImportResult {
  const board = parseTaskBoard(markdown);
  const result: ImportResult = { imported: 0, skipped: [] };

  const existingSlugs = new Set(listTasks(db).map((t) => t.slug).filter(Boolean) as string[]);
  const existingTitles = new Set(listTasks(db).filter((t) => t.status !== 'done').map((t) => t.title));

  // File order is priority order (top first); insert at bottom to preserve it.
  for (const task of board.tasks) {
    const status = statusFor(task);
    if (!status) {
      result.skipped.push({ title: task.title, reason: `runtime/history (${task.status})` });
      continue;
    }
    const slug = task.meta.id;
    if (slug && existingSlugs.has(slug)) {
      result.skipped.push({ title: task.title, reason: `id:${slug} already imported` });
      continue;
    }
    if (!slug && existingTitles.has(task.title)) {
      result.skipped.push({ title: task.title, reason: 'duplicate title already present' });
      continue;
    }

    const draft: NewTask = {
      title: task.title,
      status,
      body: cleanBody(task.body),
      slug,
      needs: task.meta.needs,
      group_key: task.meta.group,
      recur_n: task.meta.recur,
      model: normModel(task.meta.model),
      think: normThink(task.meta.thinkingLevel),
      repo: repoFor(task.title),
      note: status === 'failed' ? task.meta.reason : undefined,
    };
    const id = addTask(db, draft, { at: 'bottom' });
    if (slug) existingSlugs.add(slug);
    existingTitles.add(task.title);
    // Sanity: ensure it landed.
    if (getTask(db, id)) result.imported++;
  }

  return result;
}
