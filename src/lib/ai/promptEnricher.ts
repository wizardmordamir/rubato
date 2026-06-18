/**
 * Smart prompt enrichment for local art generation. Each preset bakes in the
 * boilerplate style/quality constraints so the user (or an agent) writes only the
 * subject — "a wizard", "a settings gear" — and still gets a usable asset (flat
 * background for sprites, layout realism for web mockups, etc.). `raw_creative`
 * is a deliberate escape hatch: no modifiers, the prompt is passed through verbatim.
 */

import type { ArtPresetType } from '../appApis';

interface PresetModifier {
  positive: string;
  negative: string;
}

/** Positive/negative style matrices per preset. */
export const ART_PRESETS: Record<ArtPresetType, PresetModifier> = {
  web_ui: {
    positive:
      'ultra-clean modern web design UI mockup, landing page concept, glassmorphic UI layout trend, precise spacing, beautiful composition, crisp typography, 8k resolution, flat graphic design presentation',
    negative:
      'blurry text, skewed components, 3d render distortion, photorealistic real-world camera noise, low resolution, messy overlaps',
  },
  game_art_2d: {
    positive:
      'isolated asset, 2d game sprite graphic, vector style asset, crisp details, uniform lighting, flat solid black background, perfect symmetry, game asset layout, sticker sheet design, clean alpha-ready outline',
    negative:
      '3d camera perspective depth, environmental background clutter, realism shadows, gradients blending into backgrounds, photorealism, text',
  },
  abstract_texture: {
    positive:
      'seamlessly tiling texture, abstract pattern asset, liquid gradient vector wave, cyberpunk holographic noise canvas, graphic texture map, wallpaper background asset, high frequency micro details',
    negative: 'buttons, interfaces, recognizable objects, texts, borders, human faces, text tags, frames',
  },
  app_icon: {
    positive:
      'minimalist 3d squircle icon design, app store icon asset, smooth glossy clay claymation render style, centered single object frame, isolated on a stark contrast flat background, modern mobile application branding vector',
    negative: 'complex text strings, multiple floating pieces, rectangular full scenes, borders, realistic landscape',
  },
  raw_creative: { positive: '', negative: '' },
};

/** Human-readable labels for each preset (UI selector). */
export const ART_PRESET_LABELS: Record<ArtPresetType, string> = {
  web_ui: 'Web UI mockup',
  game_art_2d: '2D game art',
  abstract_texture: 'Abstract texture',
  app_icon: 'App icon',
  raw_creative: 'Raw / no preset',
};

export interface EnrichedPrompt {
  /** The positive prompt sent to the diffusion model. */
  prompt: string;
  /** The negative prompt (empty for raw_creative). */
  negativePrompt: string;
}

/**
 * Compose the final positive + negative prompts for a preset. `raw_creative`
 * returns the prompt untouched with no negative; otherwise the preset's positive
 * modifiers are appended to the raw prompt and its negatives are returned.
 */
export function enrichPrompt(rawPrompt: string, preset: ArtPresetType): EnrichedPrompt {
  const trimmed = rawPrompt.trim();
  const mod = ART_PRESETS[preset] ?? ART_PRESETS.raw_creative;
  if (!mod.positive) return { prompt: trimmed, negativePrompt: mod.negative };
  const prompt = trimmed ? `${trimmed}, ${mod.positive}` : mod.positive;
  return { prompt, negativePrompt: mod.negative };
}
