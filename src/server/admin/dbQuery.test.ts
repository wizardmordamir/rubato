import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  buildWhere,
  countRows,
  escapeLike,
  getColumns,
  listTableNames,
  requireTable,
  runFilteredQuery,
} from './dbQuery';

function seed(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER, note TEXT)`);
  const ins = db.query(`INSERT INTO items (name, qty, note) VALUES (?, ?, ?)`);
  ins.run('apple', 3, 'fresh');
  ins.run('banana', 10, null);
  ins.run('apple pie', 1, '50% off');
  ins.run('cherry_bomb', 2, 'underscore_name');
  return db;
}

describe('admin dbQuery', () => {
  let db: Database;
  beforeEach(() => {
    db = seed();
  });

  test('listTableNames lists user tables (and the query excludes sqlite_%)', () => {
    expect(listTableNames(db)).toEqual(['items']);
  });

  test('requireTable rejects unknown tables (no injection)', () => {
    expect(() => requireTable(db, 'items')).not.toThrow();
    expect(() => requireTable(db, 'items; DROP TABLE items')).toThrow(/unknown table/);
    expect(() => requireTable(db, 'sqlite_master')).toThrow(/unknown table/);
  });

  test('getColumns + countRows', () => {
    expect(getColumns(db, 'items').map((c) => c.name)).toEqual(['id', 'name', 'qty', 'note']);
    expect(countRows(db, 'items')).toBe(4);
  });

  test('escapeLike escapes LIKE metacharacters', () => {
    expect(escapeLike('50%_x\\y')).toBe('50\\%\\_x\\\\y');
  });

  test('buildWhere rejects unknown columns', () => {
    expect(() => buildWhere(getColumns(db, 'items'), [{ column: 'evil', op: 'eq', value: 'x' }])).toThrow(
      /unknown column/,
    );
  });

  test('eq filter on a numeric column coerces the value', () => {
    const r = runFilteredQuery(db, 'items', { filters: [{ column: 'qty', op: 'gte', value: '3' }] });
    expect(r.rows.map((x) => x.name).sort()).toEqual(['apple', 'banana']);
    expect(r.total).toBe(2);
  });

  test('contains matches a literal % (escaped, not a wildcard)', () => {
    const r = runFilteredQuery(db, 'items', { filters: [{ column: 'note', op: 'contains', value: '50%' }] });
    expect(r.rows.map((x) => x.name)).toEqual(['apple pie']);
  });

  test('contains matches a literal underscore (not any-char)', () => {
    // "_name" must match the underscore literally; "underscore_name" matches, others don't.
    const r = runFilteredQuery(db, 'items', { filters: [{ column: 'note', op: 'contains', value: '_name' }] });
    expect(r.rows.map((x) => x.name)).toEqual(['cherry_bomb']);
  });

  test('startswith / endswith / neq', () => {
    expect(
      runFilteredQuery(db, 'items', { filters: [{ column: 'name', op: 'startswith', value: 'apple' }] }).rows.length,
    ).toBe(2);
    expect(
      runFilteredQuery(db, 'items', { filters: [{ column: 'name', op: 'endswith', value: 'pie' }] }).rows.map(
        (x) => x.name,
      ),
    ).toEqual(['apple pie']);
    expect(runFilteredQuery(db, 'items', { filters: [{ column: 'name', op: 'neq', value: 'apple' }] }).total).toBe(3);
  });

  test('isnull / isnotnull', () => {
    expect(
      runFilteredQuery(db, 'items', { filters: [{ column: 'note', op: 'isnull' }] }).rows.map((x) => x.name),
    ).toEqual(['banana']);
    expect(runFilteredQuery(db, 'items', { filters: [{ column: 'note', op: 'isnotnull' }] }).total).toBe(3);
  });

  test('pagination + total: limit/offset page through, total is unfiltered-by-page', () => {
    const r = runFilteredQuery(db, 'items', { limit: 2, offset: 0, orderBy: 'id', orderDir: 'asc' });
    expect(r.total).toBe(4);
    expect(r.rows.length).toBe(2);
    expect(r.limit).toBe(2);
    const r2 = runFilteredQuery(db, 'items', { limit: 2, offset: 2, orderBy: 'id', orderDir: 'asc' });
    expect(r2.rows.map((x) => x.id)).toEqual([3, 4]);
  });

  test('limit is clamped to <= 1000 and >= 1', () => {
    expect(runFilteredQuery(db, 'items', { limit: 99999 }).limit).toBe(1000);
    expect(runFilteredQuery(db, 'items', { limit: 0 }).limit).toBe(1); // clamped up to the floor
    expect(runFilteredQuery(db, 'items', {}).limit).toBe(100); // unset → default
  });

  test('orderBy ignores a non-column (no injection)', () => {
    // A bogus orderBy is simply dropped; the query still runs.
    const r = runFilteredQuery(db, 'items', { orderBy: 'id; DROP TABLE items' });
    expect(r.total).toBe(4);
    expect(listTableNames(db)).toEqual(['items']); // table still there
  });
});
