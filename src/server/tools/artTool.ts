/**
 * Agentic tool: generate local art on demand. Used both by the general agentic
 * chat ("add a wizard sprite to the landing page") and by the Art Co-Pilot mode,
 * where the model has already crafted an SDXL-optimal prompt and drives the full
 * Fooocus quality surface (styles, performance, aspect, seed). Writes a PNG under
 * the app's generated-assets (sandboxed to RUBATO_HOME, gated by `art.enabled`)
 * and returns the asset URL so the model can embed it inline.
 */

import { ART_PRESETS } from '../../lib/ai/promptEnricher';
import type { ArtPresetType } from '../../lib/appApis';
import { type FooocusPerformance, resolveAspect } from '../../shared/art';
import { DiffusionOfflineError, DiffusionTimeoutError } from '../art/diffusion';
import { generateArt } from '../art/generateImage';
import type { RepoTool, ToolResult } from './types';

/** Map the friendly `quality` arg to a Fooocus performance preset (installed-safe). */
function toPerformance(quality: unknown): FooocusPerformance | undefined {
  const q = String(quality ?? '').toLowerCase();
  if (q === 'quality' || q === 'high') return 'Quality';
  if (q === 'speed' || q === 'fast') return 'Speed';
  return undefined;
}

export const generatePlaceholderArtwork: RepoTool = {
  spec: {
    name: 'generate_placeholder_artwork',
    description:
      'Generate a local image via the Fooocus SDXL engine. Pass a single rich, comma-separated, ' +
      'keyword-dense `prompt` (subject, composition, lighting, medium, mood, detail) — Fooocus expands ' +
      'it further. Use `negative_prompt` for things to avoid (never put negations in `prompt`). ' +
      'Optional knobs: `aspect_ratio` (square|portrait|tall|landscape|wide|ultrawide), `quality` ' +
      '(speed|quality), `styles` (comma-separated Fooocus styles, e.g. "Fooocus Cinematic, Sai Fantasy Art"), ' +
      'and `seed` (reuse to reproduce or vary an image). `preset` is an optional shortcut for ' +
      'common asset types: web_ui, game_art_2d, abstract_texture, app_icon, raw_creative (default).',
    params: [
      {
        name: 'prompt',
        type: 'string',
        description: 'the full descriptive art prompt (subject + style details)',
        required: true,
      },
      { name: 'negative_prompt', type: 'string', description: 'things to avoid in the image', required: false },
      {
        name: 'aspect_ratio',
        type: 'string',
        description: 'square | portrait | tall | landscape | wide | ultrawide (default square)',
        required: false,
      },
      {
        name: 'quality',
        type: 'string',
        description: 'speed (faster) | quality (slower, best) — default speed',
        required: false,
      },
      {
        name: 'styles',
        type: 'string',
        description:
          'comma-separated CURATED Fooocus style names (e.g. "Fooocus Cinematic, Sai Fantasy Art"); ' +
          'unknown names are silently ignored, so use exact names from the curated set',
        required: false,
      },
      {
        name: 'seed',
        type: 'number',
        description: 'reuse a previous image’s seed to reproduce/vary it',
        required: false,
      },
      {
        name: 'preset',
        type: 'string',
        description: 'web_ui | game_art_2d | abstract_texture | app_icon | raw_creative',
        required: false,
      },
    ],
  },
  async run({ app }, params): Promise<ToolResult> {
    const requestedPreset = String(params.preset ?? '');
    const preset: ArtPresetType = requestedPreset in ART_PRESETS ? (requestedPreset as ArtPresetType) : 'raw_creative';
    const aspect = params.aspect_ratio != null ? resolveAspect(String(params.aspect_ratio)) : undefined;
    const styles =
      typeof params.styles === 'string' && params.styles.trim()
        ? params.styles
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    try {
      const result = await generateArt({
        appId: app?.name,
        prompt: String(params.prompt ?? ''),
        preset,
        negativePrompt: params.negative_prompt != null ? String(params.negative_prompt) : undefined,
        width: aspect?.width,
        height: aspect?.height,
        performance: toPerformance(params.quality),
        styles,
        seed: params.seed != null ? Number(params.seed) : undefined,
      });
      return {
        ok: true,
        content:
          `Generated a ${result.width}×${result.height} image → ${result.url}\n` +
          `Embed it in your reply to the user with markdown exactly like: ![${result.preset === 'raw_creative' ? 'generated image' : preset}](${result.url})\n` +
          `Styles: ${result.styles.join(', ')} | performance: ${result.performance}` +
          (result.seed != null ? ` | seed: ${result.seed} (reuse this seed to make a variation)` : '') +
          `\nFinal prompt: ${result.enrichedPrompt}`,
      };
    } catch (err) {
      // Offline (server down) and timeout (server up but slow) are distinct — both
      // carry an actionable message the model relays to the user. Don't conflate them.
      if (err instanceof DiffusionOfflineError || err instanceof DiffusionTimeoutError) {
        return { ok: false, content: err.message };
      }
      return { ok: false, content: err instanceof Error ? err.message : 'image generation failed' };
    }
  },
};
