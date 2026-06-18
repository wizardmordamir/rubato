/**
 * Build an app's context index: walk → filter to text → chunk → (embed) → store.
 *
 * The walk honors the app's `.gitignore` files (nested) plus git's global
 * excludes (`core.excludesFile`) and `.git/info/exclude` — so anything git
 * ignores (including conventions like `___*`/`*.ignore.*` living in the global
 * file) stays out, and editing those files changes indexing with no code change.
 * Per-app `ai.include`/`ai.exclude` globs refine it further.
 *
 * Embeddings are computed only when a model is staged (embeddingAvailable); the
 * stored scorer is "hybrid" then, "bm25" otherwise. Re-index is incremental:
 * unchanged files (same content hash) are skipped, changed ones re-chunked, and
 * vanished ones deleted. A scorer/model change forces a full rebuild.
 */

import { embeddingAvailable, embeddingFromConfig, resolveEmbedModel } from '../api/embeddings/fromConfig';
import { buildAppMap } from '../lib/ai/appMap';
import { chunkContent } from '../lib/ai/codeChunk';
import { readTextFiles } from '../lib/ai/textFiles';
import type { AppConfig } from '../lib/apps';
import { loadConfig } from '../lib/config';
import { gitExcludePatterns } from '../lib/git';
import { walkFiles } from '../lib/walkFiles';
import type { IndexStatus } from '../shared/types';
import {
  countIndex,
  deleteApp,
  deleteFile,
  fileSignatures,
  getStatus,
  recordAppMap,
  recordStatus,
  replaceFileChunks,
} from './aiDb';
import { emit } from './events';

/** A path that looks like a stale backup/mirror rather than the live working tree. */
function looksStale(absolutePath: string): boolean {
  return /[/\\](backups?|stale|mirror|archive)[/\\]/i.test(absolutePath);
}

export async function indexApp(app: AppConfig, opts: { force?: boolean } = {}): Promise<IndexStatus> {
  emit({ type: 'index:status', status: { app: app.name, state: 'indexing' } });
  try {
    const cfg = await loadConfig();
    const lines = cfg.ai?.chunkLines ?? 60;
    const overlap = cfg.ai?.chunkOverlap ?? 10;

    const wantEmbeddings = await embeddingAvailable(app);
    const targetScorer: Exclude<IndexStatus['scorer'], undefined> = wantEmbeddings ? 'hybrid' : 'bm25';
    const embedder = wantEmbeddings ? await embeddingFromConfig(app) : null;
    const embedModel = wantEmbeddings ? await resolveEmbedModel(app) : null;
    const dims = embedder?.dimensions ?? null;

    // Force a full rebuild when the scorer or embedding model changed.
    const prev = getStatus(app.name);
    const force = opts.force || !prev || prev.scorer !== targetScorer || prev.model !== (embedModel ?? undefined);
    if (force) deleteApp(app.name);
    const existing = force ? new Map() : fileSignatures(app.name);

    const files = await walkFiles(app.absolutePath, {
      respectGitignore: true,
      extraIgnores: await gitExcludePatterns(app.absolutePath),
    });
    const texts = await readTextFiles(files, { include: app.ai?.include, exclude: app.ai?.exclude });

    const seen = new Set<string>();
    for (const f of texts) {
      seen.add(f.relativePath);
      const hash = Bun.hash(f.content).toString(16);
      if (existing.get(f.relativePath)?.hash === hash) continue; // unchanged

      const chunks = chunkContent(f.relativePath, f.content, { lines, overlap });
      if (chunks.length === 0) {
        deleteFile(app.name, f.relativePath);
        continue;
      }

      let embeddings: (Float32Array | null)[] = chunks.map(() => null);
      if (embedder) {
        const vecs = await embedder.embed(chunks.map((c) => c.text));
        embeddings = vecs.map((v) => Float32Array.from(v));
      }

      replaceFileChunks(
        app.name,
        f.relativePath,
        hash,
        0,
        chunks.map((c, i) => ({
          chunkIndex: c.index,
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
          embedding: embeddings[i],
          embedModel,
          dims,
        })),
      );
    }

    // Drop files that vanished from disk.
    for (const path of existing.keys()) if (!seen.has(path)) deleteFile(app.name, path);

    const { files: fileCount, chunks: chunkCount } = countIndex(app.name);
    recordStatus(app.name, { scorer: targetScorer, files: fileCount, chunks: chunkCount, model: embedModel, dims });

    // App Map: built from the files we just read (no second walk) and stored for
    // the ask path to prepend to the system prompt. Best-effort — a failure here
    // must not fail the index.
    try {
      recordAppMap(app.name, buildAppMap(texts) || null);
    } catch {
      /* non-fatal: leave the map untouched */
    }

    // Loudly flag indexing a stale backup/mirror path — almost always a misconfig
    // (e.g. apps.json points at /backups/<app> instead of the live working tree).
    const warning = looksStale(app.absolutePath)
      ? `Indexed a path that looks like a stale backup/mirror: ${app.absolutePath}. ` +
        'Point this app at your live working tree if answers seem out of date.'
      : undefined;

    const status: IndexStatus = {
      app: app.name,
      state: 'indexed',
      scorer: targetScorer,
      files: fileCount,
      chunks: chunkCount,
      model: embedModel ?? undefined,
      lastIndexedAt: Date.now(),
      warning,
    };
    emit({ type: 'index:status', status });
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordStatus(app.name, { scorer: 'bm25', files: 0, chunks: 0, error: message });
    const status: IndexStatus = { app: app.name, state: 'error', error: message };
    emit({ type: 'index:status', status });
    return status;
  }
}
