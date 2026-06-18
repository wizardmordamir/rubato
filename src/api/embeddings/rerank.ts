/**
 * Cross-encoder re-ranking. Bi-encoder retrieval (embeddings) scores the query
 * and a chunk independently, so it can't see how they interact; a cross-encoder
 * reads the pair together and judges true relevance, surfacing the chunk that
 * actually answers the question. We run it as a *re-rank* over the top retrieval
 * candidates: cheap to score a few dozen, big quality win.
 *
 * Inference runs in a `worker_threads` Worker so the (multi-second, CPU-bound)
 * ONNX loop never blocks the event loop and stall the live `/ws` answer stream.
 * Everything degrades gracefully: no package, no staged model, or any worker
 * error → the input order is returned unchanged, so retrieval never breaks.
 */

import { Worker } from 'node:worker_threads';
import { localEmbeddingsInstalled, modelStaged } from './fromConfig';
import { MODELS_DIR } from './local';

export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

const WORKER_TIMEOUT_MS = 60_000;

/** Whether re-ranking can run right now (optional package present + model staged). */
export function rerankAvailable(model: string = DEFAULT_RERANK_MODEL): boolean {
  try {
    return localEmbeddingsInstalled() && modelStaged(model);
  } catch {
    return false;
  }
}

/**
 * Sort items by a parallel score array (descending), then optionally take the
 * top-K. Pure and stable on ties (keeps the retrieval order) — the testable core
 * of re-ranking, independent of the ONNX worker.
 */
export function sortByScores<T>(items: T[], scores: number[], topK?: number): T[] {
  const ranked = items
    .map((item, i) => ({ item, score: scores[i] ?? Number.NEGATIVE_INFINITY, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.item);
  return typeof topK === 'number' ? ranked.slice(0, topK) : ranked;
}

/** Score query/passage pairs in a worker thread; rejects on error/timeout. */
function scoreInWorker(query: string, passages: string[], model: string, timeoutMs: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./rerankWorker.ts', import.meta.url), {
      workerData: { query, passages, model, modelsDir: MODELS_DIR },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('rerank worker timed out'));
    }, timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    worker.on('message', (msg: { ok: boolean; scores?: number[]; error?: string }) => {
      if (msg.ok && msg.scores) done(() => resolve(msg.scores as number[]));
      else done(() => reject(new Error(msg.error ?? 'rerank worker failed')));
    });
    worker.on('error', (err) => done(() => reject(err)));
    worker.on('exit', (code) => {
      if (code !== 0) done(() => reject(new Error(`rerank worker exited (${code})`)));
    });
  });
}

/**
 * Re-rank items (anything with a `text` field) against the query with the local
 * cross-encoder, returning them best-first (optionally truncated to `topK`).
 * Returns the input unchanged when re-ranking is unavailable or anything fails.
 */
export async function rerank<T extends { text: string }>(
  query: string,
  items: T[],
  opts: { model?: string; topK?: number; timeoutMs?: number } = {},
): Promise<T[]> {
  if (items.length <= 1) return items;
  const model = opts.model ?? DEFAULT_RERANK_MODEL;
  if (!rerankAvailable(model)) return items;
  try {
    const scores = await scoreInWorker(
      query,
      items.map((i) => i.text),
      model,
      opts.timeoutMs ?? WORKER_TIMEOUT_MS,
    );
    return sortByScores(items, scores, opts.topK);
  } catch {
    return typeof opts.topK === 'number' ? items.slice(0, opts.topK) : items;
  }
}
