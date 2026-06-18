/**
 * Worker thread for cross-encoder re-ranking. Loads the staged ONNX model via
 * transformers.js (remote models disabled — air-gapped safe) and scores each
 * query/passage pair, posting the relevance logits back to the main thread.
 *
 * Runs OFF the main event loop on purpose: model load + a few dozen forward
 * passes is CPU-bound and would otherwise stall the live answer stream. Any
 * failure is reported as `{ ok:false }` so the caller falls back to input order.
 */

import { parentPort, workerData } from 'node:worker_threads';

interface RerankJob {
  query: string;
  passages: string[];
  model: string;
  modelsDir: string;
}

async function main(): Promise<void> {
  const { query, passages, model, modelsDir } = workerData as RerankJob;
  // @huggingface/transformers is an optional peer dep; the caller only spawns
  // this worker when the model is staged + the package resolves.
  const { env, AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
  env.localModelPath = modelsDir;
  env.cacheDir = modelsDir;
  env.allowRemoteModels = false; // staged offline; never reach for the Hub

  const tokenizer = await AutoTokenizer.from_pretrained(model);
  const reranker = await AutoModelForSequenceClassification.from_pretrained(model, { dtype: 'q8' });

  const scores: number[] = [];
  for (const passage of passages) {
    const inputs = tokenizer(query, { text_pair: passage, padding: true, truncation: true });
    const { logits } = await reranker(inputs);
    // ms-marco cross-encoders emit a single relevance logit per pair.
    scores.push(Number(logits.data[0]));
  }
  parentPort?.postMessage({ ok: true, scores });
}

main().catch((err) => {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
});
