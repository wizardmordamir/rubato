/**
 * Best-effort detection of which databases an app uses, from its package.json
 * dependencies. Used to SEED an app's `db` tag list (via the Apps page "Detect"
 * button) — the user then owns/edits it, so a wrong guess is one click to fix and
 * never silently overrides their config. Pure + dependency-free.
 *
 * Only well-known driver packages map to a db (a high-signal, low-false-positive
 * set). ORMs (prisma/typeorm/sequelize/knex) are deliberately NOT mapped to a db
 * because they don't tell us which one — add those by hand if you want them.
 */

/** package name → canonical db tag. */
const DB_DRIVERS: Record<string, string> = {
  mongodb: 'mongodb',
  mongoose: 'mongodb',
  pg: 'postgres',
  'pg-promise': 'postgres',
  postgres: 'postgres',
  'postgres.js': 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  mssql: 'mssql',
  tedious: 'mssql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  'node:sqlite': 'sqlite',
  redis: 'redis',
  ioredis: 'redis',
  oracledb: 'oracle',
  'cassandra-driver': 'cassandra',
  '@elastic/elasticsearch': 'elasticsearch',
  '@aws-sdk/client-dynamodb': 'dynamodb',
};

export interface DetectedTech {
  /** Canonical db tags inferred from known drivers (sorted, deduped). */
  dbs: string[];
  /** Which dependency implied each tag, so the UI can show provenance. */
  sources: { pkg: string; tag: string }[];
}

/** Detect db tags from a merged dependency map ({ name: version }). */
export function detectTechFromDeps(deps: Record<string, unknown>): DetectedTech {
  const tags = new Set<string>();
  const sources: { pkg: string; tag: string }[] = [];
  for (const pkg of Object.keys(deps)) {
    const tag = DB_DRIVERS[pkg];
    if (tag) {
      sources.push({ pkg, tag });
      tags.add(tag);
    }
  }
  return { dbs: [...tags].sort(), sources };
}

/** Detect db tags from a parsed package.json (deps + devDeps + optional + peer). */
export function detectTechFromPackageJson(pkg: Record<string, unknown> | undefined): DetectedTech {
  if (!pkg) return { dbs: [], sources: [] };
  const merged: Record<string, unknown> = {};
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const section = pkg[key];
    if (section && typeof section === 'object') Object.assign(merged, section);
  }
  return detectTechFromDeps(merged);
}
