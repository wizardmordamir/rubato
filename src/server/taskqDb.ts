/**
 * Server-side handle to the standalone taskq database (`~/.taskq/taskq.sqlite`,
 * resolved + migrated by the cwip/taskq engine). Distinct from rubato's own
 * `rubato.sqlite` (getDb): the queue is a portable, cross-repo store the
 * orchestrator + CLI also open, so it lives under `TASKQ_HOME`/`TASKQ_DB`.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyRecommendedPragmas } from 'cwip/sqlite';
import { migrate, type TaskqDb, taskqDbPath } from 'cwip/taskq';

let db: Database | null = null;

/** The shared taskq handle (WAL + foreign_keys; auto-migrated on first open). */
export function getTaskqDb(): TaskqDb {
  if (db) return db as unknown as TaskqDb;
  const path = taskqDbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  applyRecommendedPragmas(db, { foreignKeys: true });
  migrate(db as unknown as TaskqDb);
  return db as unknown as TaskqDb;
}

/** Test-only: close + delete the DB files so the next open rebuilds fresh. */
export function __resetTaskqDbForTests(): void {
  if (db) {
    db.close();
    db = null;
  }
  const path = taskqDbPath();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${path}${suffix}`, { force: true });
    } catch {
      // not present — fine.
    }
  }
}
