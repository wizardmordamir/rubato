/**
 * Storage for the app context index: one row per file chunk, with an optional
 * embedding vector (Float32Array stored as a BLOB). Shares the per-machine
 * SQLite handle from db.ts. Embeddings use brute-force cosine in TS at query
 * time — no native vector extension, so it survives a locked-down machine.
 */

import type { Database } from 'bun:sqlite';
import { addColumnIfMissing } from 'cwip/sqlite';
import type { StoredChunk } from '../lib/ai/types';
import type { IndexStatus } from '../shared/types';
import { getDb } from './db';

let ensured = false;

function db(): Database {
  const conn = getDb();
  if (!ensured) {
    conn.run(`
      CREATE TABLE IF NOT EXISTS ai_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB,
        embed_model TEXT,
        dims INTEGER
      )
    `);
    conn.run('CREATE INDEX IF NOT EXISTS ai_chunks_app ON ai_chunks(app)');
    conn.run('CREATE INDEX IF NOT EXISTS ai_chunks_app_file ON ai_chunks(app, relative_path)');
    conn.run(`
      CREATE TABLE IF NOT EXISTS ai_index_status (
        app TEXT PRIMARY KEY,
        scorer TEXT NOT NULL,
        files INTEGER NOT NULL,
        chunks INTEGER NOT NULL,
        model TEXT,
        dims INTEGER,
        indexed_at INTEGER NOT NULL,
        last_error TEXT
      )
    `);
    // App Map: a compact markdown overview of the app (routes/endpoints/dirs)
    // prepended to the system prompt so the model isn't blind to the app's shape.
    // Additive — older rows carry NULL until the next reindex.
    addColumnIfMissing(conn, 'ai_index_status', 'app_map', 'TEXT');
    ensured = true;
  }
  return conn;
}

/** Copy a SQLite BLOB into a fresh, aligned Float32Array. */
function blobToVec(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/** One file's current signature, for incremental re-index diffing. */
export interface FileSignature {
  hash: string;
  mtimeMs: number;
}

/** Map of relativePath → {hash, mtimeMs} for everything currently indexed for an app. */
export function fileSignatures(app: string): Map<string, FileSignature> {
  const rows = db()
    .query<{ relative_path: string; file_hash: string; mtime_ms: number }, [string]>(
      'SELECT DISTINCT relative_path, file_hash, mtime_ms FROM ai_chunks WHERE app = ?',
    )
    .all(app);
  const map = new Map<string, FileSignature>();
  for (const r of rows) map.set(r.relative_path, { hash: r.file_hash, mtimeMs: r.mtime_ms });
  return map;
}

/** A chunk to persist for a file. */
export interface ChunkInput {
  chunkIndex: number;
  startLine: number;
  endLine: number;
  text: string;
  embedding?: Float32Array | null;
  embedModel?: string | null;
  dims?: number | null;
}

/** Replace all chunks for one file (delete-then-insert in a transaction). */
export function replaceFileChunks(
  app: string,
  relativePath: string,
  fileHash: string,
  mtimeMs: number,
  rows: ChunkInput[],
): void {
  const conn = db();
  const tx = conn.transaction(() => {
    conn.run('DELETE FROM ai_chunks WHERE app = ? AND relative_path = ?', [app, relativePath]);
    const insert = conn.query(
      `INSERT INTO ai_chunks
        (app, relative_path, file_hash, mtime_ms, chunk_index, start_line, end_line, text, embedding, embed_model, dims)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(
        app,
        relativePath,
        fileHash,
        mtimeMs,
        r.chunkIndex,
        r.startLine,
        r.endLine,
        r.text,
        r.embedding ? Buffer.from(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength) : null,
        r.embedModel ?? null,
        r.dims ?? null,
      );
    }
  });
  tx();
}

export function deleteFile(app: string, relativePath: string): void {
  db().run('DELETE FROM ai_chunks WHERE app = ? AND relative_path = ?', [app, relativePath]);
}

export function deleteApp(app: string): void {
  const conn = db();
  conn.run('DELETE FROM ai_chunks WHERE app = ?', [app]);
  conn.run('DELETE FROM ai_index_status WHERE app = ?', [app]);
}

interface ChunkRow {
  relative_path: string;
  chunk_index: number;
  start_line: number;
  end_line: number;
  text: string;
  embedding: Uint8Array | null;
}

/** All chunks for an app, for in-memory retrieval. */
export function loadChunks(app: string): StoredChunk[] {
  return db()
    .query<ChunkRow, [string]>(
      'SELECT relative_path, chunk_index, start_line, end_line, text, embedding FROM ai_chunks WHERE app = ? ORDER BY relative_path, chunk_index',
    )
    .all(app)
    .map((r) => ({
      relativePath: r.relative_path,
      chunkIndex: r.chunk_index,
      startLine: r.start_line,
      endLine: r.end_line,
      text: r.text,
      embedding: r.embedding ? blobToVec(r.embedding) : undefined,
    }));
}

/** Current file + chunk counts for an app (after incremental upserts/deletes). */
export function countIndex(app: string): { files: number; chunks: number } {
  const row = db()
    .query<{ files: number; chunks: number }, [string]>(
      'SELECT COUNT(DISTINCT relative_path) AS files, COUNT(*) AS chunks FROM ai_chunks WHERE app = ?',
    )
    .get(app);
  return { files: row?.files ?? 0, chunks: row?.chunks ?? 0 };
}

interface StatusRow {
  app: string;
  scorer: string;
  files: number;
  chunks: number;
  model: string | null;
  dims: number | null;
  indexed_at: number;
  last_error: string | null;
}

export interface StatusInput {
  scorer: Exclude<IndexStatus['scorer'], undefined>;
  files: number;
  chunks: number;
  model?: string | null;
  dims?: number | null;
  error?: string | null;
}

/** Upsert an app's index status. */
export function recordStatus(app: string, s: StatusInput): void {
  db().run(
    `INSERT INTO ai_index_status (app, scorer, files, chunks, model, dims, indexed_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(app) DO UPDATE SET
       scorer = excluded.scorer, files = excluded.files, chunks = excluded.chunks,
       model = excluded.model, dims = excluded.dims, indexed_at = excluded.indexed_at,
       last_error = excluded.last_error`,
    [app, s.scorer, s.files, s.chunks, s.model ?? null, s.dims ?? null, Date.now(), s.error ?? null],
  );
}

/** Store the generated App Map markdown for an app (best-effort; status row must exist). */
export function recordAppMap(app: string, appMap: string | null): void {
  db().run('UPDATE ai_index_status SET app_map = ? WHERE app = ?', [appMap ?? null, app]);
}

/** The stored App Map markdown for an app, or null if none / never indexed. */
export function getAppMap(app: string): string | null {
  const row = db()
    .query<{ app_map: string | null }, [string]>('SELECT app_map FROM ai_index_status WHERE app = ?')
    .get(app);
  return row?.app_map ?? null;
}

/** The stored index status for an app, or null if never indexed. */
export function getStatus(app: string): IndexStatus | null {
  const row = db().query<StatusRow, [string]>('SELECT * FROM ai_index_status WHERE app = ?').get(app);
  if (!row) return null;
  return {
    app: row.app,
    state: row.last_error ? 'error' : 'indexed',
    scorer: row.scorer as IndexStatus['scorer'],
    files: row.files,
    chunks: row.chunks,
    model: row.model ?? undefined,
    lastIndexedAt: row.indexed_at,
    error: row.last_error ?? undefined,
  };
}
