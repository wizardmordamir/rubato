/**
 * Retrieve the most relevant chunks for a question, choosing a scorer:
 *   - "bm25"      lexical only (always available, no model)
 *   - "embedding" semantic only (needs staged vectors)
 *   - "hybrid"    BM25 + embedding fused with RRF
 *   - "auto"      hybrid when the app has vectors, else bm25
 * Anything needing vectors falls back to BM25 when the app has none or the
 * embedder fails — the ask path never errors out over retrieval.
 */

import { shouldLogMessage } from 'cwip';
import { embeddingFromConfig } from '../api/embeddings/fromConfig';
import { DEFAULT_RERANK_MODEL, rerank, rerankAvailable } from '../api/embeddings/rerank';
import { bm25Search } from '../lib/ai/bm25';
import { vectorSearch } from '../lib/ai/cosine';
import { expandFileContext } from '../lib/ai/expand';
import { rrfFuse } from '../lib/ai/hybrid';
import type { RetrievedChunk, StoredChunk } from '../lib/ai/types';
import type { AiGlobalConfig } from '../lib/appApis';
import type { AppConfig } from '../lib/apps';
import { loadConfig } from '../lib/config';
import { classifyError, startDiagnostics } from '../lib/diagnostics';
import type { Scorer } from '../shared/types';
import { loadChunks } from './aiDb';

/**
 * Record an embedding-provider failure that silently degraded retrieval to BM25 —
 * otherwise this is invisible (the ask still answers, just worse). Throttled via
 * cwip's `shouldLogMessage` so a persistently broken embedder can't flood the
 * diagnostics dir. Fire-and-forget, best-effort.
 */
function noteEmbeddingDegraded(app: AppConfig, err: unknown): void {
  if (!shouldLogMessage(`embed-degrade:${app.name}`, 'embedding')) return;
  const d = startDiagnostics({
    activity: 'embedding-degraded',
    intent: `embedding retrieval for "${app.name}" fell back to BM25`,
    console: false,
  });
  d.warn('embedding provider failed; using lexical (BM25) retrieval', {
    app: app.name,
    classification: classifyError(err),
    error: err instanceof Error ? err.message : String(err),
  });
  void d.finish('warn');
}

/** Rank the top-K chunks for a question with the configured scorer (pre-expansion). */
async function rank(
  app: AppConfig,
  question: string,
  chunks: StoredChunk[],
  topK: number,
  ai: AiGlobalConfig,
): Promise<RetrievedChunk[]> {
  const hasVectors = chunks.some((c) => c.embedding);
  let scorer: Scorer = app.ai?.scorer ?? ai.scorer ?? 'auto';
  if (scorer === 'auto') scorer = hasVectors ? 'hybrid' : 'bm25';
  if ((scorer === 'embedding' || scorer === 'hybrid') && !hasVectors) scorer = 'bm25';

  if (scorer === 'bm25') return bm25Search(chunks, question, { topK });

  // Embed the live query for semantic / hybrid retrieval.
  let queryVec: Float32Array;
  try {
    const provider = await embeddingFromConfig(app);
    const [vec] = await provider.embed([question]);
    queryVec = Float32Array.from(vec);
  } catch (err) {
    noteEmbeddingDegraded(app, err);
    return bm25Search(chunks, question, { topK }); // embedder unavailable → lexical
  }

  const semantic = vectorSearch(chunks, queryVec, topK);
  if (scorer === 'embedding') return semantic;

  const lexical = bm25Search(chunks, question, { topK });
  return rrfFuse([lexical, semantic], 60, topK);
}

export async function retrieve(
  app: AppConfig,
  question: string,
  opts: { topK?: number; expand?: boolean } = {},
): Promise<RetrievedChunk[]> {
  const ai = (await loadConfig()).ai ?? {};
  const topK = opts.topK ?? ai.topK ?? 20;
  const chunks = loadChunks(app.name);
  if (chunks.length === 0) return [];

  // Cross-encoder re-rank: pull a WIDER candidate pool from the fast retriever,
  // then re-score that pool with the cross-encoder and keep the true top-K. Only
  // when a rerank model is staged (else it's a no-op and we just take top-K).
  const rerankModel = app.ai?.rerankModel ?? ai.rerankModel ?? DEFAULT_RERANK_MODEL;
  const rerankOn = (app.ai?.rerank ?? ai.rerank ?? true) && rerankAvailable(rerankModel);
  const poolK = rerankOn ? topK * 3 : topK;
  const pool = await rank(app, question, chunks, poolK, ai);
  const ranked = rerankOn ? await rerank(question, pool, { model: rerankModel, topK }) : pool;

  // Expand ranked files to their sibling chunks so whole-file / enumeration
  // questions aren't answered from a single slice. On by default; opts wins.
  const expand = opts.expand ?? app.ai?.expandFiles ?? ai.expandFiles ?? true;
  if (!expand) return ranked;
  return expandFileContext(ranked, chunks, {
    maxFiles: ai.expandMaxFiles,
    maxChunksPerFile: ai.expandMaxChunksPerFile,
  });
}
