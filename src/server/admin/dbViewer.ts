/**
 * Read-only viewer over the live rubato SQLite DB for the Admin page: list tables
 * with row counts, per-table stats (size when the `dbstat` virtual table is
 * available), and run the shared injection-safe filtered query. All reads go
 * through `dbQuery`, which whitelists every table/column name.
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RUBATO_HOME } from '../../lib/config';
import type { DbStats, QueryRequest, QueryResult, TableInfo, TableStat } from '../../shared/ui';
import { getDb } from '../db';
import { countRows, listTableNames, runFilteredQuery } from './dbQuery';

const DB_FILE = resolve(RUBATO_HOME, 'rubato.sqlite');

/** Tables + row counts. */
export function listDbTables(): TableInfo[] {
  const db = getDb();
  return listTableNames(db).map((name) => ({ name, rowCount: countRows(db, name) }));
}

/** Bytes a table occupies via the dbstat virtual table, or null when unavailable. */
function tableSizeBytes(name: string): number | null {
  try {
    const db = getDb();
    const row = db.query('SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name = ?').get(name) as {
      bytes: number | null;
    } | null;
    return row?.bytes ?? null;
  } catch {
    return null; // dbstat not compiled in
  }
}

/** Per-table stats + the DB file size. */
export async function dbStats(): Promise<DbStats> {
  const db = getDb();
  const tables: TableStat[] = listTableNames(db).map((name) => ({
    name,
    rowCount: countRows(db, name),
    sizeBytes: tableSizeBytes(name),
  }));
  tables.sort((a, b) => b.rowCount - a.rowCount);
  let dbFileBytes = 0;
  try {
    dbFileBytes = (await stat(DB_FILE)).size;
  } catch {
    // DB file not yet on disk
  }
  return { tables, dbFileBytes };
}

/** Filtered query against one live table (read-only). */
export function queryDbTable(table: string, req: QueryRequest): QueryResult {
  return runFilteredQuery(getDb(), table, req);
}
