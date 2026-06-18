/**
 * Ollama daemon control for the Orchestration "Ollama" tab. Speaks the native
 * Ollama HTTP API (`/api/*`) for model management + status, shells out to
 * `ollama serve` to start the daemon, and writes rubato's `ai.direct.model` so a
 * GET/forge request stops failing with "model is required".
 *
 * The native API root is derived from rubato's LLM config (`ai.direct.baseUrl`
 * or `RUBATO_LLM_URL`) by stripping the OpenAI-compat `/v1[/chat/completions]`
 * suffix; it defaults to http://localhost:11434.
 */

import { optionalEnv } from '../api/env';
import { loadConfig, saveConfig } from '../lib/config';
import type { OllamaModel, OllamaRunningModel, OllamaStatus } from '../shared/ollama';

const DEFAULT_BASE = 'http://localhost:11434';

/** Native API root (no `/v1`), derived from the configured chat endpoint. */
export async function ollamaBaseUrl(): Promise<string> {
  const configured = (await loadConfig()).ai?.direct?.baseUrl ?? optionalEnv('RUBATO_LLM_URL');
  if (!configured) return DEFAULT_BASE;
  return configured
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '')
    .replace(/\/v1$/, '');
}

/** Configured chat model (`ai.direct.model`), or null. */
async function configuredModel(): Promise<string | null> {
  return (await loadConfig()).ai?.direct?.model ?? null;
}

/** Fetch with a short timeout so a dead daemon fails fast instead of hanging. */
async function call(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const base = await ollamaBaseUrl();
  const { timeoutMs = 5000, ...rest } = init ?? {};
  return fetch(`${base}${path}`, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}

export async function getStatus(): Promise<OllamaStatus> {
  const baseUrl = await ollamaBaseUrl();
  const model = await configuredModel();
  try {
    const res = await call('/api/version', { timeoutMs: 2500 });
    const body = (await res.json()) as { version?: string };
    return { running: res.ok, version: body.version ?? null, baseUrl, model };
  } catch (e) {
    return { running: false, version: null, baseUrl, model, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listModels(): Promise<OllamaModel[]> {
  const res = await call('/api/tags');
  if (!res.ok) throw new Error(`Ollama /api/tags → ${res.status}`);
  return ((await res.json()) as { models?: OllamaModel[] }).models ?? [];
}

export async function listRunning(): Promise<OllamaRunningModel[]> {
  const res = await call('/api/ps');
  if (!res.ok) throw new Error(`Ollama /api/ps → ${res.status}`);
  return ((await res.json()) as { models?: OllamaRunningModel[] }).models ?? [];
}

/** Pull (download) a model. Non-streaming — the request resolves when done. */
export async function pullModel(name: string): Promise<{ status: string }> {
  const res = await call('/api/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, stream: false }),
    timeoutMs: 30 * 60_000, // large models take a while
  });
  const body = (await res.json()) as { status?: string; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `pull failed → ${res.status}`);
  return { status: body.status ?? 'success' };
}

export async function deleteModel(name: string): Promise<void> {
  const res = await call('/api/delete', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`delete failed → ${res.status}`);
}

export async function showModel(name: string): Promise<unknown> {
  const res = await call('/api/show', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`show failed → ${res.status}`);
  return res.json();
}

/** Unload a running model now (sets keep_alive to 0 via a no-op generate). */
export async function unloadModel(name: string): Promise<void> {
  const res = await call('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name, keep_alive: 0 }),
  });
  if (!res.ok) throw new Error(`unload failed → ${res.status}`);
}

/** Set rubato's active chat model (writes `ai.direct.*`). Fixes "model is required". */
export async function setActiveModel(name: string): Promise<OllamaStatus> {
  const cfg = await loadConfig();
  const base = await ollamaBaseUrl();
  cfg.ai = cfg.ai ?? {};
  cfg.ai.provider = cfg.ai.provider ?? 'direct';
  cfg.ai.direct = cfg.ai.direct ?? {};
  if (!cfg.ai.direct.baseUrl) cfg.ai.direct.baseUrl = `${base}/v1`;
  cfg.ai.direct.model = name;
  await saveConfig(cfg);
  return getStatus();
}

/** Start the Ollama daemon (`ollama serve`) detached; resolves after it answers. */
export async function startDaemon(): Promise<OllamaStatus> {
  if ((await getStatus()).running) return getStatus();
  try {
    const proc = Bun.spawn(['ollama', 'serve'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    proc.unref();
  } catch (e) {
    throw new Error(
      `Could not launch "ollama serve" (is the ollama CLI installed and on PATH?): ${e instanceof Error ? e.message : e}`,
    );
  }
  // Poll up to ~6s for the daemon to come up.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await getStatus()).running) break;
  }
  return getStatus();
}
