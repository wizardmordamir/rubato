#!/usr/bin/env bun
/**
 * One-time cutover importer: read the legacy `TASKS.md` (the orchestration notes
 * dir) and load its still-actionable entries into the taskq queue. Idempotent —
 * safe to re-run (skips already-imported ids/titles). Pass a path to override.
 *
 *   bun run src/scripts/taskqImport.ts [path/to/TASKS.md]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getNeeds, listTasks, renderTasksMarkdown, taskqHome } from 'cwip/taskq';
import { notesDir } from '../server/orchestration';
import { importTasksMd } from '../server/taskq/importer';
import { getTaskqDb } from '../server/taskqDb';

async function main(): Promise<void> {
  const path = process.argv[2] ?? join(await notesDir(), 'TASKS.md');
  const markdown = readFileSync(path, 'utf8');
  const db = getTaskqDb();
  const result = importTasksMd(db, markdown);

  process.stdout.write(`taskq import from ${path}: ${result.imported} imported, ${result.skipped.length} skipped\n`);
  for (const s of result.skipped) process.stdout.write(`  skip "${s.title.slice(0, 60)}" — ${s.reason}\n`);

  // Refresh the markdown mirror.
  const rows = listTasks(db);
  const needs: Record<number, string[]> = {};
  for (const t of rows) {
    const n = getNeeds(db, t.id);
    if (n.length) needs[t.id] = n;
  }
  writeFileSync(join(taskqHome(), 'TASKS.view.md'), renderTasksMarkdown(rows, needs));
}

if (import.meta.main)
  main().catch((e) => {
    process.stderr.write(`taskq import error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
