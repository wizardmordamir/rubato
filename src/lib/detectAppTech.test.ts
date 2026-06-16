import { describe, expect, test } from 'bun:test';
import { detectTechFromDeps, detectTechFromPackageJson } from './detectAppTech';

describe('detectTechFromDeps', () => {
  test('maps known drivers to canonical db tags, deduped + sorted', () => {
    const { dbs, sources } = detectTechFromDeps({ mongoose: '^8', mongodb: '^6', pg: '^8', express: '^5' });
    expect(dbs).toEqual(['mongodb', 'postgres']);
    // mongoose AND mongodb both contribute the mongodb tag (two sources, one tag).
    expect(sources).toContainEqual({ pkg: 'mongoose', tag: 'mongodb' });
    expect(sources).toContainEqual({ pkg: 'mongodb', tag: 'mongodb' });
  });

  test('does not infer a db from an ORM alone (ambiguous)', () => {
    expect(detectTechFromDeps({ prisma: '^5', knex: '^3' }).dbs).toEqual([]);
  });

  test('maps mssql/tedious → mssql and better-sqlite3 → sqlite', () => {
    expect(detectTechFromDeps({ mssql: '^10' }).dbs).toEqual(['mssql']);
    expect(detectTechFromDeps({ tedious: '^18' }).dbs).toEqual(['mssql']);
    expect(detectTechFromDeps({ 'better-sqlite3': '^11' }).dbs).toEqual(['sqlite']);
  });
});

describe('detectTechFromPackageJson', () => {
  test('merges deps + devDeps + peer + optional', () => {
    const pkg = {
      dependencies: { mysql2: '^3' },
      devDependencies: { ioredis: '^5' },
      peerDependencies: { mssql: '^10' },
    };
    expect(detectTechFromPackageJson(pkg).dbs).toEqual(['mssql', 'mysql', 'redis']);
  });

  test('returns empty for a missing package.json', () => {
    expect(detectTechFromPackageJson(undefined)).toEqual({ dbs: [], sources: [] });
  });
});
