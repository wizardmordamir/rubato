/**
 * SQLite backups for the Admin page: create / list / delete / download point-in-
 * time snapshots of the rubato DB, inspect a backup's tables read-only, and
 * restore selected tables over the live DB (with an automatic safety snapshot).
 * Ported from cursedalchemy's admin backup tooling, trimmed to a local single-user
 * tool (no S3, no scheduler — backups are taken on demand from the UI).
 *
 * Snapshots use `VACUUM INTO`, which writes a clean, consistent DELETE-journal copy
 * (safe to take while the WAL-mode live DB is in use, and safe to open read-only).
 */

import { Database } from 'bun:sqlite';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { RUBATO_HOME } from '../../lib/config';
import type { BackupInfo, QueryRequest, QueryResult, RestoreResult, TableInfo } from '../../shared/ui';
import { getDb } from '../db';
import { countRows, getColumns, listTableNames, runFilteredQuery } from './dbQuery';

/** Where snapshots live. */
const BACKUPS_DIR = resolve(RUBATO_HOME, 'backups');
/** Auto safety-snapshot prefix (taken before a restore). */
const SAFETY_PREFIX = 'pre-restore-';

/** The backups dir, created if missing. */
async function ensureBackupsDir(): Promise<string> {
  await mkdir(BACKUPS_DIR, { recursive: true });
  return BACKUPS_DIR;
}

/** A filesystem-safe ISO-ish timestamp for a file name (no `:` or `.`). */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Resolve a client-supplied backup file name to an absolute path inside the
 * backups dir. Refuses traversal / absolute paths / non-`.sqlite` names. The
 * name must be a bare basename.
 */
export function resolveBackupPath(fileName: string): string {
  const name = (fileName ?? '').trim();
  if (!name || name.includes('/') || name.includes('\\') || isAbsolute(name) || name.includes('..')) {
    throw new Error('invalid backup file name');
  }
  if (!name.endsWith('.sqlite')) throw new Error('not a .sqlite backup');
  return resolve(BACKUPS_DIR, name);
}

/** List backups (newest first). Safety snapshots are flagged. */
export async function listBackups(): Promise<BackupInfo[]> {
  await ensureBackupsDir();
  let names: string[];
  try {
    names = (await readdir(BACKUPS_DIR)).filter((n) => n.endsWith('.sqlite'));
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const fileName of names) {
    try {
      const st = await stat(resolve(BACKUPS_DIR, fileName));
      out.push({ fileName, size: st.size, modifiedAt: st.mtimeMs, safety: fileName.startsWith(SAFETY_PREFIX) });
    } catch {
      // vanished — skip
    }
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

/** Take a snapshot of the live DB. `prefix` lets the restore path tag safety copies. */
export async function createBackup(prefix = 'rubato-'): Promise<BackupInfo> {
  await ensureBackupsDir();
  const fileName = `${prefix}${stamp()}.sqlite`;
  const fullPath = resolve(BACKUPS_DIR, fileName);
  // VACUUM INTO a fresh path — a clean, consistent snapshot of the WAL-mode DB.
  getDb().query('VACUUM INTO ?').run(fullPath);
  const st = await stat(fullPath);
  return { fileName, size: st.size, modifiedAt: st.mtimeMs, safety: fileName.startsWith(SAFETY_PREFIX) };
}

/** Delete a backup file. Returns false if it wasn't there. */
export async function deleteBackup(fileName: string): Promise<boolean> {
  const path = resolveBackupPath(fileName);
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/** The absolute path to stream for a download, or null if it doesn't exist. */
export async function backupFilePath(fileName: string): Promise<string | null> {
  const path = resolveBackupPath(fileName);
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** Open a backup read-only for inspection. Caller must `.close()`. */
function openBackup(fileName: string): Database {
  const path = resolveBackupPath(fileName);
  return new Database(path, { readonly: true });
}

/** List a backup's user tables + row counts (read-only). */
export function backupTables(fileName: string): TableInfo[] {
  const db = openBackup(fileName);
  try {
    return listTableNames(db).map((name) => ({ name, rowCount: countRows(db, name) }));
  } finally {
    db.close();
  }
}

/** Run a filtered query against one table of a backup (read-only). */
export function queryBackupTable(fileName: string, table: string, req: QueryRequest): QueryResult {
  const db = openBackup(fileName);
  try {
    return runFilteredQuery(db, table, req);
  } finally {
    db.close();
  }
}

/**
 * Restore selected tables from a backup over the live DB. Before any write it
 * snapshots the live DB (a `pre-restore-*` safety backup). Only tables present in
 * BOTH the backup and the live DB are restored, copying just the columns they
 * share, all inside a single transaction. Returns what was restored vs skipped.
 */
export async function restoreBackup(fileName: string, tables: string[]): Promise<RestoreResult> {
  const src = resolveBackupPath(fileName);
  const requested = [...new Set(tables)].filter(Boolean);
  if (requested.length === 0) throw new Error('no tables selected');

  // 1) Safety snapshot of the current DB before we touch anything.
  const safety = await createBackup(SAFETY_PREFIX);

  // 2) Introspect the backup (read-only) to build the restore plan.
  const srcDb = openBackup(fileName);
  const db = getDb();
  const restored: RestoreResult['restored'] = [];
  const skipped: RestoreResult['skipped'] = [];

  try {
    const liveTables = new Set(listTableNames(db));
    const srcTables = new Set(listTableNames(srcDb));

    type Plan = { table: string; cols: string[] };
    const plans: Plan[] = [];
    for (const table of requested) {
      if (!srcTables.has(table)) {
        skipped.push({ table, reason: 'not in backup' });
        continue;
      }
      if (!liveTables.has(table)) {
        skipped.push({ table, reason: 'not in live DB' });
        continue;
      }
      const liveCols = new Set(getColumns(db, table).map((c) => c.name));
      const cols = getColumns(srcDb, table)
        .map((c) => c.name)
        .filter((c) => liveCols.has(c));
      if (cols.length === 0) {
        skipped.push({ table, reason: 'no shared columns' });
        continue;
      }
      plans.push({ table, cols });
    }

    if (plans.length > 0) {
      db.query('ATTACH DATABASE ? AS restore_src').run(src);
      try {
        const run = db.transaction(() => {
          for (const { table, cols } of plans) {
            const q = `"${table.replace(/"/g, '""')}"`;
            const colList = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
            db.run(`DELETE FROM main.${q}`);
            const res = db.query(`INSERT INTO main.${q} (${colList}) SELECT ${colList} FROM restore_src.${q}`).run();
            restored.push({ table, rowsCopied: Number(res.changes) });
          }
        });
        run();
      } finally {
        db.run('DETACH DATABASE restore_src');
      }
    }
  } finally {
    srcDb.close();
  }

  return { fileName, safetyBackup: safety.fileName, restored, skipped };
}
