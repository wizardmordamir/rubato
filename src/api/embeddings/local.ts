/**
 * Local embedding provider — runs an ONNX sentence-transformer in-process via
 * transformers.js (WASM backend, no native addon). The model is staged offline
 * under ~/.rubato/models (see `rubato-ai-setup`); we load it with remote models
 * disabled so a locked-down machine never tries to reach the Hub.
 *
 * transformers.js is imported lazily so the (heavy) runtime only loads when
 * embeddings are actually used — BM25-only setups never pay for it.
 */

import { resolve } from 'node:path';
import { RUBATO_HOME } from '../../lib/config';
import type { EmbeddingProvider } from '../llm/types';

/** Where staged models live (honors RUBATO_HOME). */
export const MODELS_DIR = resolve(RUBATO_HOME, 'models');

export const DEFAULT_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_EMBED_DIMS = 384;

/** A minimal view of the transformers.js feature-extraction pipeline. */
type FeaturePipeline = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export interface LocalEmbeddingConfig {
  model?: string;
  dimensions?: number;
}

export function createLocalEmbeddingProvider(config: LocalEmbeddingConfig = {}): EmbeddingProvider {
  const model = config.model ?? DEFAULT_EMBED_MODEL;
  const dimensions = config.dimensions ?? DEFAULT_EMBED_DIMS;
  let pipePromise: Promise<FeaturePipeline> | null = null;

  function getPipe(): Promise<FeaturePipeline> {
    if (!pipePromise) {
      pipePromise = (async () => {
        // @huggingface/transformers is an OPTIONAL peer dep (heavy: bundles an
        // ONNX runtime). It's loaded lazily so the library/CLI work without it;
        // when it's genuinely needed (local embeddings) and absent, fail with an
        // actionable message instead of a raw module-resolution error.
        const mod = await import('@huggingface/transformers').catch(() => {
          throw new Error(
            "Local embeddings need the optional '@huggingface/transformers' package, which isn't installed. " +
              'Run `bun add @huggingface/transformers` (then `rubato-ai-setup` to stage the model), ' +
              'or configure a remote embeddings endpoint (ai.embeddings.provider = "remote"). ' +
              'Without it, retrieval falls back to BM25 keyword search.',
          );
        });
        const { env, pipeline } = mod;
        env.localModelPath = MODELS_DIR;
        env.cacheDir = MODELS_DIR;
        env.allowRemoteModels = false; // staged offline; never reach for the Hub
        return (await pipeline('feature-extraction', model, { dtype: 'q8' })) as unknown as FeaturePipeline;
      })();
    }
    return pipePromise;
  }

  return {
    name: 'local',
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const pipe = await getPipe();
      const out = await pipe(texts, { pooling: 'mean', normalize: true });
      return out.tolist();
    },
  };
}
