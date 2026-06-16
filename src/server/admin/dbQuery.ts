/**
 * Injection-safe, read-only filtered-query engine over a bun:sqlite database —
 * shared by the live DB viewer and the backup viewer. Ported from cursedalchemy's
 * admin db tooling.
 *
 * Security model: NOTHING from the client is ever interpolated into SQL.
 *   - Table + column names are whitelisted against the DB's own catalog
 *     (`sqlite_master` / `PRAGMA table_info`) before use.
 *   - Operators come from a fixed map, never the request.
 *   - User values are always bound parameters; LIKE patterns are escaped so `%`/`_`
 *     match literally (with an explicit `ESCAPE` clause).
 * Even so, this only ever runs SELECT/COUNT against an admin-gated, loopback server.
 */

import type { Database } from 'bun:sqlite';
import type { ColumnInfo, FilterOp, QueryFilter, QueryRequest, QueryResult } from '../../shared/ui';

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

/** User tables (excludes sqlite internal + virtual-table shadow tables). */
export function listTableNames(db: Database): string[] {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/** Assert a client-supplied table name is a real table; returns it or throws. */
export function requireTable(db: Database, table: string): string {
  if (!listTableNames(db).includes(table)) throw new Error(`unknown table: ${table}`);
  return table;
}

/** Columns of a table (already whitelisted by `requireTable`). PRAGMA is safe to quote-inject the name. */
export function getColumns(db: Database, table: string): ColumnInfo[] {
  // table is whitelisted via requireTable; still quote it defensively.
  const rows = db.query(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as {
    name: string;
    type: string;
  }[];
  return rows.map((r) => ({ name: r.name, type: r.type ?? '' }));
}

/** Row count of a whitelisted table. */
export function countRows(db: Database, table: string): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`).get() as { n: number };
  return row.n;
}

/** Escape a value so it's a literal in a LIKE pattern (paired with ESCAPE '\\'). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** SQL fragment + bound params for one whitelisted column. Nullary ops bind nothing. */
const COMPARATORS: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const LIKE_OPS = new Set<FilterOp>(['contains', 'notcontains', 'startswith', 'endswith']);

/** Numeric SQLite types coerce the bound value to a number so comparisons aren't string-wise. */
function isNumericType(type: string): boolean {
  return /INT|REAL|NUM|FLOA|DOUB/i.test(type);
}

/** Build a parameterized WHERE clause from filters over whitelisted columns. */
export function buildWhere(
  columns: ColumnInfo[],
  filters: QueryFilter[],
): { clause: string; params: (string | number)[] } {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const parts: string[] = [];
  const params: (string | number)[] = [];

  for (const f of filters) {
    const col = byName.get(f.column);
    if (!col) throw new Error(`unknown column: ${f.column}`);
    const q = `"${col.name.replace(/"/g, '""')}"`;

    if (f.op === 'isnull') {
      parts.push(`${q} IS NULL`);
      continue;
    }
    if (f.op === 'isnotnull') {
      parts.push(`${q} IS NOT NULL`);
      continue;
    }

    const raw = f.value ?? '';
    if (f.op in COMPARATORS) {
      parts.push(`${q} ${COMPARATORS[f.op]} ?`);
      params.push(isNumericType(col.type) && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw);
      continue;
    }
    if (LIKE_OPS.has(f.op)) {
      const esc = escapeLike(raw);
      const pattern =
        f.op === 'contains' || f.op === 'notcontains' ? `%${esc}%` : f.op === 'startswith' ? `${esc}%` : `%${esc}`;
      parts.push(`${q} ${f.op === 'notcontains' ? 'NOT LIKE' : 'LIKE'} ? ESCAPE '\\'`);
      params.push(pattern);
      continue;
    }
    throw new Error(`unknown operator: ${f.op}`);
  }

  return { clause: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

/**
 * Run a paginated, filtered SELECT over a whitelisted table and return a page of
 * rows plus the total matching count. Read-only.
 */
export function runFilteredQuery(db: Database, table: string, req: QueryRequest): QueryResult {
  requireTable(db, table);
  const columns = getColumns(db, table);
  const colNames = new Set(columns.map((c) => c.name));

  const { clause, params } = buildWhere(columns, req.filters ?? []);
  const quoted = `"${table.replace(/"/g, '""')}"`;

  const total = (db.query(`SELECT COUNT(*) AS n FROM ${quoted} ${clause}`).get(...params) as { n: number }).n;

  const limit = Math.min(MAX_LIMIT, Math.max(1, req.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, req.offset ?? 0);

  let orderClause = '';
  if (req.orderBy && colNames.has(req.orderBy)) {
    const dir = req.orderDir === 'desc' ? 'DESC' : 'ASC';
    orderClause = `ORDER BY "${req.orderBy.replace(/"/g, '""')}" ${dir}`;
  }

  const rows = db
    .query(`SELECT * FROM ${quoted} ${clause} ${orderClause} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];

  return { table, columns, rows, total, limit, offset };
}
