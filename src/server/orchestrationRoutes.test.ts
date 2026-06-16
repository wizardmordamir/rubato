import { describe, expect, test } from 'bun:test';
import { sanitizePatch } from './orchestrationRoutes';

// Regression: the "Switch to fleet mode →" patch ({ fleetTiers: [...] }) and its
// "Switch to flat" counterpart ({ fleetTiers: null }) were silently dropped by
// sanitizePatch, leaving an empty patch → a 400 "invalid config patch". The route
// only gates structure; alias/slot clamping is applyDrainPatch's job.
describe('sanitizePatch — fleetTiers', () => {
  test('accepts a well-shaped fleet-tiers array (switch to fleet mode)', () => {
    const tiers = [
      { modelAlias: 'opus', slots: 2, thinkingLevel: 'high' as const, fastMode: false },
      { modelAlias: 'sonnet', slots: 4, thinkingLevel: 'off' as const, fastMode: true },
    ];
    expect(sanitizePatch({ fleetTiers: tiers })).toEqual({ fleetTiers: tiers });
  });

  test('accepts null to clear fleet mode (switch to flat)', () => {
    expect(sanitizePatch({ fleetTiers: null })).toEqual({ fleetTiers: null });
  });

  test('rejects a malformed fleet-tiers payload', () => {
    // Not an array.
    expect(sanitizePatch({ fleetTiers: 'nope' as unknown as [] })).toBeNull();
    // An entry missing required fields.
    expect(sanitizePatch({ fleetTiers: [{ modelAlias: 'opus' } as never] })).toBeNull();
  });

  test('still rejects an empty patch and validates the other fields', () => {
    expect(sanitizePatch({})).toBeNull();
    expect(sanitizePatch({ jobs: 0 })).toBeNull();
    expect(sanitizePatch({ enabled: true })).toEqual({ enabled: true });
  });
});
