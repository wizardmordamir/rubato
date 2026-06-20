import { describe, expect, test } from 'bun:test';
import { getArtTuning, saveArtTuning } from './fooocusTuning';

// RUBATO_HOME is isolated to a temp dir by the test preload, so these round-trip
// through a throwaway config.json and never touch the real ~/.rubato.

describe('saveArtTuning → getArtTuning', () => {
  test('clamps out-of-range numbers and persists in-range ones', async () => {
    const state = await saveArtTuning({
      art: { guidanceScale: 999, sharpness: -5, refinerSwitch: 9, width: 100000, height: 768, performance: 'Quality' },
    });
    expect(state.art.guidanceScale).toBe(30); // clamped to max
    expect(state.art.sharpness).toBe(0); // clamped to min
    expect(state.art.refinerSwitch).toBe(1); // clamped to 1.0
    expect(state.art.width).toBe(2048); // clamped to max
    expect(state.art.height).toBe(768); // in-range, kept
    expect(state.art.performance).toBe('Quality');

    // Persisted: a fresh read sees the same values.
    const again = await getArtTuning();
    expect(again.art.guidanceScale).toBe(30);
    expect(again.art.performance).toBe('Quality');
  });

  test('rejects an unknown performance value (keeps the prior one)', async () => {
    await saveArtTuning({ art: { performance: 'Speed' } });
    const state = await saveArtTuning({ art: { performance: 'TurboNonsense' } });
    expect(state.art.performance).toBe('Speed');
  });

  test('"None" refiner is preserved (disable lever), empty string clears the override', async () => {
    const disabled = await saveArtTuning({ art: { refinerModel: 'None' } });
    expect(disabled.art.refinerModel).toBe('None');
    const cleared = await saveArtTuning({ art: { refinerModel: '' } });
    expect(cleared.art.refinerModel).toBe(''); // resolves back to '' (engine default)
  });

  test('styles are cleaned (trim/dedupe/drop-blank) but live names are kept', async () => {
    const state = await saveArtTuning({ art: { styles: [' Fooocus V2 ', 'Fooocus V2', 'Some Live Style', ''] } });
    expect(state.art.styles).toEqual(['Fooocus V2', 'Some Live Style']);
  });

  test('memory patch is validated and its launch-flag preview is derived', async () => {
    const state = await saveArtTuning({
      memory: { vram: 'low', fp16: true, attentionSplit: true, offloadFromVram: true, disableOffload: true, bogus: 1 },
    });
    expect(state.memory.vram).toBe('low');
    expect(state.memory.fp16).toBe(true);
    // offload wins over disableOffload in the derived flags.
    expect(state.launchArgs).toEqual([
      '--always-low-vram',
      '--all-in-fp16',
      '--attention-split',
      '--always-offload-from-vram',
    ]);
  });

  test('an invalid vram mode falls back to auto (no flag)', async () => {
    const state = await saveArtTuning({ memory: { vram: 'ludicrous' } });
    expect(state.memory.vram).toBe('auto');
    expect(state.launchArgs).toEqual([]);
  });

  test('a partial art patch merges over existing config without clobbering siblings', async () => {
    await saveArtTuning({ art: { sharpness: 5, guidanceScale: 7 } });
    const state = await saveArtTuning({ art: { sharpness: 3 } }); // only sharpness this time
    expect(state.art.sharpness).toBe(3);
    expect(state.art.guidanceScale).toBe(7); // untouched
  });
});
