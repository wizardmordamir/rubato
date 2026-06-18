import { describe, expect, test } from 'bun:test';
import { ART_PRESETS, enrichPrompt } from './promptEnricher';

describe('enrichPrompt', () => {
  test('appends the preset positive modifiers and returns its negatives', () => {
    const { prompt, negativePrompt } = enrichPrompt('a wizard mascot', 'game_art_2d');
    expect(prompt.startsWith('a wizard mascot, ')).toBe(true);
    expect(prompt).toContain('2d game sprite');
    expect(negativePrompt).toBe(ART_PRESETS.game_art_2d.negative);
    expect(negativePrompt.length).toBeGreaterThan(0);
  });

  test('raw_creative passes the prompt through verbatim with no negatives', () => {
    expect(enrichPrompt('  exactly this  ', 'raw_creative')).toEqual({ prompt: 'exactly this', negativePrompt: '' });
  });

  test('empty prompt + preset yields just the positive modifiers (no leading comma)', () => {
    const { prompt } = enrichPrompt('   ', 'app_icon');
    expect(prompt).toBe(ART_PRESETS.app_icon.positive);
    expect(prompt.startsWith(',')).toBe(false);
  });

  test('every preset has a defined modifier entry', () => {
    for (const key of ['web_ui', 'game_art_2d', 'abstract_texture', 'app_icon', 'raw_creative'] as const) {
      expect(ART_PRESETS[key]).toBeDefined();
    }
  });
});
