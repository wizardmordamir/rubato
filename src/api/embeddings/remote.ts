/**
 * Remote embedding provider — calls an OpenAI-compatible `/embeddings` endpoint
 * (e.g. a local Ollama, or any gateway that exposes one). Lets you get semantic
 * search from an embedding model you already run, with no local model staging.
 */

import { type AuthConfig, createApiClient } from '../client';
import type { EmbeddingProvider } from '../llm/types';

/** A reasonable default dimension (nomic-embed-text); override per model in config. */
export const DEFAULT_REMOTE_EMBED_DIMS = 768;

export interface RemoteEmbeddingConfig {
  /** Base URL of the embeddings endpoint (e.g. http://localhost:11434/v1). */
  baseUrl: string;
  /** Path appended to baseUrl. Default "embeddings". */
  path?: string;
  model: string;
  dimensions?: number;
  auth?: AuthConfig;
  fetch?: typeof fetch;
}

interface EmbeddingsResponse {
  data: Array<{ embedding: number[]; index?: number }>;
}

export function createRemoteEmbeddingProvider(config: RemoteEmbeddingConfig): EmbeddingProvider {
  const api = createApiClient({
    name: 'embeddings',
    baseUrl: config.baseUrl,
    auth: config.auth,
    timeoutMs: 120_000,
    fetch: config.fetch,
  });
  const path = config.path ?? 'embeddings';

  return {
    name: 'remote',
    dimensions: config.dimensions ?? DEFAULT_REMOTE_EMBED_DIMS,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await api.post<EmbeddingsResponse>(path, { model: config.model, input: texts });
      const data = [...res.data.data];
      // Preserve input order if the API returns an index per item.
      if (data.every((d) => typeof d.index === 'number')) {
        data.sort((a, b) => (a.index as number) - (b.index as number));
      }
      return data.map((d) => d.embedding);
    },
  };
}
