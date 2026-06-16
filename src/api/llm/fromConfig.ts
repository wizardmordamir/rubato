/**
 * Build the active LLM provider from rubato config + secrets, so callers don't
 * wire up URLs/auth by hand. Resolution: per-app `ai.provider` → global
 * `config.ai.provider` → default "direct". URLs come from config first, then
 * ~/.rubato/.env; tokens come from .env only.
 */

import type { AppConfig } from '../../lib/apps';
import { loadConfig } from '../../lib/config';
import { optionalEnv } from '../env';
import { createDirectProvider } from './direct';
import { createFormSseProvider } from './formSse';
import type { LlmProvider } from './types';

export async function llmFromConfig(app?: AppConfig): Promise<LlmProvider> {
  const ai = (await loadConfig()).ai ?? {};
  const provider = app?.ai?.provider ?? ai.provider ?? 'direct';

  if (provider === 'direct') {
    const baseUrl = ai.direct?.baseUrl ?? optionalEnv('RUBATO_LLM_URL');
    if (!baseUrl) {
      throw new Error(
        'LLM endpoint not set. Add "ai.direct.baseUrl" to ~/.rubato/config.json or set RUBATO_LLM_URL in ~/.rubato/.env.',
      );
    }
    const token = optionalEnv('RUBATO_LLM_TOKEN');
    return createDirectProvider({
      baseUrl,
      path: ai.direct?.path,
      model: app?.ai?.model ?? ai.direct?.model,
      auth: token ? { type: 'bearer', token } : { type: 'none' },
    });
  }

  if (provider === 'form-sse') {
    const baseUrl = ai.formSse?.baseUrl ?? optionalEnv('RUBATO_FORM_LLM_URL');
    if (!baseUrl) {
      throw new Error(
        'Form-SSE endpoint not set. Add "ai.formSse.baseUrl" to ~/.rubato/config.json or set RUBATO_FORM_LLM_URL in ~/.rubato/.env.',
      );
    }
    return createFormSseProvider({
      baseUrl,
      token: optionalEnv('RUBATO_FORM_LLM_TOKEN'),
      model: app?.ai?.model ?? ai.formSse?.model,
      promptTemplate: ai.formSse?.promptTemplate,
    });
  }

  throw new Error(`Unknown LLM provider "${provider}"`);
}
