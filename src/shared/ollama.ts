/**
 * Ollama control — wire types shared by the rubato server and UI. The server
 * talks to the local Ollama daemon's native HTTP API (`/api/*`, default
 * http://localhost:11434) so the Orchestration "Ollama" tab can manage models,
 * start the daemon, set rubato's active chat model, and watch status.
 */

export interface OllamaStatus {
  /** Whether the Ollama daemon answered (`/api/version`). */
  running: boolean;
  /** Daemon version, or null when unreachable. */
  version: string | null;
  /** Native API root the server is using (no trailing `/v1`). */
  baseUrl: string;
  /** rubato's configured chat model (`ai.direct.model`), or null if unset. */
  model: string | null;
  /** Populated when the daemon is unreachable. */
  error?: string;
}

/** An installed model (from `/api/tags`). */
export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  digest?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

/** A currently-loaded model (from `/api/ps`). */
export interface OllamaRunningModel {
  name: string;
  size: number;
  size_vram: number;
  expires_at: string;
}
