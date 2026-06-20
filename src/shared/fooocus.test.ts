import { describe, expect, test } from 'bun:test';
import { FOOOCUS_MEMORY_PRESETS, FOOOCUS_VRAM_MODES, type FooocusMemoryConfig, memoryArgs } from './fooocus';

describe('memoryArgs', () => {
  test('empty / auto config yields no flags', () => {
    expect(memoryArgs(undefined)).toEqual([]);
    expect(memoryArgs({})).toEqual([]);
    expect(memoryArgs({ vram: 'auto' })).toEqual([]);
  });

  test('maps each VRAM mode to its launch flag', () => {
    expect(memoryArgs({ vram: 'high' })).toEqual(['--always-high-vram']);
    expect(memoryArgs({ vram: 'normal' })).toEqual(['--always-normal-vram']);
    expect(memoryArgs({ vram: 'low' })).toEqual(['--always-low-vram']);
    expect(memoryArgs({ vram: 'minimal' })).toEqual(['--always-no-vram']);
    expect(memoryArgs({ vram: 'cpu' })).toEqual(['--always-cpu']);
  });

  test('adds precision + attention flags', () => {
    expect(memoryArgs({ fp16: true })).toEqual(['--all-in-fp16']);
    expect(memoryArgs({ attentionSplit: true })).toEqual(['--attention-split']);
  });

  test('offload-from-vram wins over disable-offload (mutually exclusive)', () => {
    expect(memoryArgs({ offloadFromVram: true })).toEqual(['--always-offload-from-vram']);
    expect(memoryArgs({ disableOffload: true })).toEqual(['--disable-offload-from-vram']);
    expect(memoryArgs({ offloadFromVram: true, disableOffload: true })).toEqual(['--always-offload-from-vram']);
  });

  test('composes a full low-RAM config in a stable order', () => {
    const cfg: FooocusMemoryConfig = { vram: 'low', fp16: true, attentionSplit: true, offloadFromVram: true };
    expect(memoryArgs(cfg)).toEqual([
      '--always-low-vram',
      '--all-in-fp16',
      '--attention-split',
      '--always-offload-from-vram',
    ]);
  });

  test('every preset and every VRAM mode produces valid (non-empty-token) flags', () => {
    for (const m of FOOOCUS_VRAM_MODES) {
      for (const a of memoryArgs({ vram: m.value })) expect(a.startsWith('--')).toBe(true);
    }
    for (const p of FOOOCUS_MEMORY_PRESETS) {
      expect(p.key).toBeTruthy();
      for (const a of memoryArgs(p.memory)) expect(a.startsWith('--')).toBe(true);
    }
    // The headline "light" preset must actually pass the low-VRAM flag.
    const light = FOOOCUS_MEMORY_PRESETS.find((p) => p.key === 'light');
    expect(memoryArgs(light?.memory)).toContain('--always-low-vram');
  });
});
