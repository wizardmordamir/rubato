/**
 * Agentic tool: let the model generate placeholder art on demand (e.g. "add a
 * wizard sprite to the landing page"). Unlike the other built-ins this one WRITES
 * (a PNG under the app's generated-assets), but it's still safe — output is
 * sandboxed to RUBATO_HOME and gated by `art.enabled`. Returns the asset URL so
 * the model can reference it in code it writes.
 */

import { ART_PRESETS } from '../../lib/ai/promptEnricher';
import type { ArtPresetType } from '../../lib/appApis';
import { DiffusionOfflineError } from '../art/diffusion';
import { generateArt } from '../art/generateImage';
import type { RepoTool, ToolResult } from './types';

export const generatePlaceholderArtwork: RepoTool = {
  spec: {
    name: 'generate_placeholder_artwork',
    description:
      'Generate local placeholder art (web UI mockups, 2D game sprites, textures, app icons, or raw creative images). ' +
      'Saves a PNG under the app and returns its URL. `preset` must be one of: ' +
      'web_ui, game_art_2d, abstract_texture, app_icon, raw_creative.',
    params: [
      {
        name: 'prompt',
        type: 'string',
        description: 'what to draw (subject only; per-preset styling is added)',
        required: true,
      },
      {
        name: 'preset',
        type: 'string',
        description: 'web_ui | game_art_2d | abstract_texture | app_icon | raw_creative',
        required: true,
      },
      { name: 'width', type: 'number', description: 'image width px (default 1024)', required: false },
      { name: 'height', type: 'number', description: 'image height px (default 1024)', required: false },
    ],
  },
  async run({ app }, params): Promise<ToolResult> {
    const requested = String(params.preset ?? '');
    const preset: ArtPresetType = requested in ART_PRESETS ? (requested as ArtPresetType) : 'raw_creative';
    try {
      const result = await generateArt({
        appId: app?.name,
        prompt: String(params.prompt ?? ''),
        preset,
        width: params.width != null ? Number(params.width) : undefined,
        height: params.height != null ? Number(params.height) : undefined,
      });
      return {
        ok: true,
        content: `Generated ${preset} artwork → ${result.url} (saved at ${result.path}).\nEnriched prompt: ${result.enrichedPrompt}`,
      };
    } catch (err) {
      if (err instanceof DiffusionOfflineError) return { ok: false, content: err.message };
      return { ok: false, content: err instanceof Error ? err.message : 'image generation failed' };
    }
  },
};
