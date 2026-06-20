/**
 * Curated Fooocus generation knobs shared by the server (the art tool + config
 * defaults), the Art Co-Pilot system prompt, and the UI (canvas form + lightbox).
 *
 * Fooocus's biggest quality lever is its STYLE system — especially "Fooocus V2",
 * an AI prompt-expansion engine that rewrites the prompt with quality tags. We
 * expose a curated, validated subset (the full list is 200+ and many overlap) so
 * the LLM/user picks from known-good names the local Fooocus-API accepts, and a
 * bad name can never sink a whole generation. Verify the full set any time via
 * `GET <fooocus>/v1/engines/styles`.
 */

/** SDXL performance presets. NOTE: only Quality + Speed work out of the box —
 *  Extreme Speed / Lightning / Hyper-SD need step-distillation LoRAs that aren't
 *  installed by default (the API errors without them). Keep them in the type for
 *  forward-compat, but default to installed-safe modes. */
export type FooocusPerformance = 'Quality' | 'Speed' | 'Extreme Speed' | 'Lightning' | 'Hyper-SD';

/** Performance modes safe to offer on a stock Fooocus install (no extra LoRAs). */
export const ART_PERFORMANCE_OPTIONS: { value: FooocusPerformance; label: string; steps: number }[] = [
  { value: 'Speed', label: 'Speed (30 steps)', steps: 30 },
  { value: 'Quality', label: 'Quality (60 steps)', steps: 60 },
];

export const DEFAULT_PERFORMANCE: FooocusPerformance = 'Speed';

/** All performance values Fooocus accepts (for runtime validation of untrusted input). */
const ALL_PERFORMANCE: FooocusPerformance[] = ['Quality', 'Speed', 'Extreme Speed', 'Lightning', 'Hyper-SD'];

/** Validate an untrusted performance value; undefined when not a known preset. */
export function normalizePerformance(value: unknown): FooocusPerformance | undefined {
  return typeof value === 'string' && (ALL_PERFORMANCE as string[]).includes(value)
    ? (value as FooocusPerformance)
    : undefined;
}

/** Clamp a number into [min,max], returning undefined for non-finite input. */
export function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/**
 * Curated high-value styles (exact Fooocus key strings). `Fooocus V2` is the
 * prompt-expansion quality engine and should almost always be on; `Fooocus
 * Enhance` + `Fooocus Sharp` round out a strong default stack.
 */
export const CURATED_ART_STYLES: { value: string; label: string }[] = [
  { value: 'Fooocus V2', label: 'Fooocus V2 (prompt expansion)' },
  { value: 'Fooocus Enhance', label: 'Fooocus Enhance' },
  { value: 'Fooocus Sharp', label: 'Fooocus Sharp' },
  { value: 'Fooocus Masterpiece', label: 'Masterpiece' },
  { value: 'Fooocus Cinematic', label: 'Cinematic' },
  { value: 'Fooocus Photograph', label: 'Photograph' },
  { value: 'Fooocus Negative', label: 'Strong Negative' },
  { value: 'Sai Cinematic', label: 'SAI Cinematic' },
  { value: 'Sai Photographic', label: 'SAI Photographic' },
  { value: 'Sai Enhance', label: 'SAI Enhance' },
  { value: 'Sai Fantasy Art', label: 'Fantasy Art' },
  { value: 'Sai Digital Art', label: 'Digital Art' },
  { value: 'Sai Anime', label: 'Anime' },
  { value: 'Sai Analog Film', label: 'Analog Film' },
  { value: 'Sai Comic Book', label: 'Comic Book' },
  { value: 'Sai Line Art', label: 'Line Art' },
  { value: 'Sai 3D Model', label: '3D Model' },
  { value: 'Cinematic Diva', label: 'Cinematic Diva' },
  { value: 'Artstyle Hyperrealism', label: 'Hyperrealism' },
  { value: 'Photo Hdr', label: 'HDR Photo' },
  { value: 'Photo Neon Noir', label: 'Neon Noir' },
  { value: 'Mre Cinematic Dynamic', label: 'Cinematic Dynamic' },
];

/** The set of valid style keys (for validation + dedupe). */
export const CURATED_ART_STYLE_SET = new Set(CURATED_ART_STYLES.map((s) => s.value));

/** The always-on quality engine — folded into every style stack. */
export const QUALITY_ENGINE_STYLE = 'Fooocus V2';

/** Default style stack: AI prompt expansion + enhance + sharpen. */
export const DEFAULT_ART_STYLES: string[] = ['Fooocus V2', 'Fooocus Enhance', 'Fooocus Sharp'];

/**
 * Aspect ratios mapped to Fooocus-valid `width*height` pairs (must be one of
 * Fooocus's 26 supported sizes, else the API rejects the request). Keyed by a
 * friendly name the LLM/user can pick.
 */
export const ART_ASPECTS = [
  { key: 'square', label: 'Square', width: 1024, height: 1024 },
  { key: 'portrait', label: 'Portrait', width: 896, height: 1152 },
  { key: 'tall', label: 'Tall', width: 832, height: 1216 },
  { key: 'landscape', label: 'Landscape', width: 1152, height: 896 },
  { key: 'wide', label: 'Wide', width: 1216, height: 832 },
  { key: 'ultrawide', label: 'Ultrawide', width: 1344, height: 768 },
] as const;

export type ArtAspectKey = (typeof ART_ASPECTS)[number]['key'];

/**
 * Resolve a friendly aspect key (or a raw "W*H"/"WxH" string) to a width/height.
 * Falls back to square when unrecognized.
 */
export function resolveAspect(input: string | undefined): { width: number; height: number } {
  if (input) {
    const named = ART_ASPECTS.find((a) => a.key === input.toLowerCase());
    if (named) return { width: named.width, height: named.height };
    const m = input.match(/^(\d{3,4})\s*[*x×]\s*(\d{3,4})$/i);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  return { width: 1024, height: 1024 };
}

/**
 * Sanitize a requested style list: keep only known-good keys, dedupe, and ensure
 * the quality engine is present (and first). Falls back to the default stack when
 * nothing valid was given.
 */
export function normalizeArtStyles(styles: string[] | undefined): string[] {
  const valid = (styles ?? []).map((s) => s.trim()).filter((s) => CURATED_ART_STYLE_SET.has(s));
  const chosen = valid.length ? valid : DEFAULT_ART_STYLES;
  const withEngine = chosen.includes(QUALITY_ENGINE_STYLE) ? chosen : [QUALITY_ENGINE_STYLE, ...chosen];
  return [...new Set(withEngine)];
}

/**
 * Gentler cleanup for the user's *configured* default style stack (the tuning
 * page), which may legitimately reference live engine styles beyond the curated
 * 20. Unlike {@link normalizeArtStyles} it does NOT drop unknown names (the picker
 * only offers real ones) and does NOT force the quality engine — so the user can
 * deliberately remove "Fooocus V2". It only trims, drops blanks, dedupes, caps the
 * count, and falls back to the default stack when the selection is empty.
 */
export function cleanStyleStack(styles: string[] | undefined, max = 16): string[] {
  const cleaned = [...new Set((styles ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, max);
  return cleaned.length ? cleaned : DEFAULT_ART_STYLES;
}
