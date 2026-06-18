/**
 * Resolve the embedding provider from config, and report whether it's usable.
 * Two backends: "local" (a transformers.js model staged on disk) and "remote"
 * (an OpenAI-compatible /embeddings endpoint, e.g. Ollama). `embeddingAvailable`
 * is what lets retrieval degrade to BM25 instead of erroring — it never throws.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from '../../lib/apps';
import { loadConfig } from '../../lib/config';
import { optionalEnv } from '../env';
import type { EmbeddingProvider } from '../llm/types';
import { createLocalEmbeddingProvider, DEFAULT_EMBED_DIMS, DEFAULT_EMBED_MODEL, isOfflineMode, MODELS_DIR } from './local';
import { createRemoteEmbeddingProvider, DEFAULT_REMOTE_EMBED_DIMS } from './remote';

/** The model id rubato will use for an app (per-app → global → default). */
export async function resolveEmbedModel(app?: AppConfig): Promise<string> {
  const ai = (await loadConfig()).ai ?? {};
  return app?.ai?.embeddingModel ?? ai.embeddings?.model ?? DEFAULT_EMBED_MODEL;
}

/**
 * Whether the optional '@huggingface/transformers' peer dep is installed. Probed
 * by resolution only (no module execution), so checking is cheap. When absent,
 * `embeddingAvailable` reports false and retrieval degrades to BM25 instead of
 * erroring mid-run on a staged-but-unusable model.
 */
export function localEmbeddingsInstalled(): boolean {
  try {
    Bun.resolveSync('@huggingface/transformers', import.meta.dir);
    return true;
  } catch {
    return false;
  }
}

/** True if a local model's files are staged under ~/.rubato/models/<id>/. */
export function modelStaged(model: string): boolean {
  const dir = resolve(MODELS_DIR, ...model.split('/'));
  return (
    existsSync(resolve(dir, 'config.json')) &&
    existsSync(resolve(dir, 'tokenizer.json')) &&
    existsSync(resolve(dir, 'onnx', 'model_quantized.onnx'))
  );
}

/** Whether embeddings can run for this app right now. */
export async function embeddingAvailable(app?: AppConfig): Promise<boolean> {
  try {
    const emb = (await loadConfig()).ai?.embeddings ?? {};
    if ((emb.provider ?? 'local') === 'remote') {
      return Boolean(emb.baseUrl ?? optionalEnv('RUBATO_EMBEDDINGS_URL'));
    }
    // Local always needs the optional package. Offline, the model must also be
    // pre-staged (no Hub); connected, it can be fetched on first use.
    if (!localEmbeddingsInstalled()) return false;
    return isOfflineMode() ? modelStaged(await resolveEmbedModel(app)) : true;
  } catch {
    return false;
  }
}

export async function embeddingFromConfig(app?: AppConfig): Promise<EmbeddingProvider> {
  const emb = (await loadConfig()).ai?.embeddings ?? {};

  if ((emb.provider ?? 'local') === 'remote') {
    const baseUrl = emb.baseUrl ?? optionalEnv('RUBATO_EMBEDDINGS_URL');
    if (!baseUrl) {
      throw new Error(
        'Remote embeddings endpoint not set. Add "ai.embeddings.baseUrl" to ~/.rubato/config.json or set RUBATO_EMBEDDINGS_URL.',
      );
    }
    const model = app?.ai?.embeddingModel ?? emb.model;
    if (!model) {
      throw new Error('Remote embeddings model not set. Add "ai.embeddings.model" (e.g. "nomic-embed-text").');
    }
    const token = optionalEnv('RUBATO_EMBEDDINGS_TOKEN');
    return createRemoteEmbeddingProvider({
      baseUrl,
      path: emb.path,
      model,
      dimensions: emb.dimensions ?? DEFAULT_REMOTE_EMBED_DIMS,
      auth: token ? { type: 'bearer', token } : { type: 'none' },
    });
  }

  return createLocalEmbeddingProvider({
    model: await resolveEmbedModel(app),
    dimensions: emb.dimensions ?? DEFAULT_EMBED_DIMS,
  });
}
