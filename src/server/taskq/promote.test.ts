import { describe, expect, test } from 'bun:test';
import {
  ancestryFrom,
  decideCycle,
  decideRepo,
  decideSystem,
  healReason,
  integrationNeedsHeal,
  isActionSafeWhileBusy,
  promoteShaStillVerified,
  type RepoState,
  repoGreen,
} from './promote';

describe('ancestryFrom', () => {
  test('equal tips → equal', () => {
    expect(ancestryFrom({ equal: true, mainIsAncestorOfIntegration: true, integrationIsAncestorOfMain: true })).toBe(
      'equal',
    );
  });
  test('integration ahead → main-behind', () => {
    expect(ancestryFrom({ equal: false, mainIsAncestorOfIntegration: true, integrationIsAncestorOfMain: false })).toBe(
      'main-behind',
    );
  });
  test('main ahead → main-ahead', () => {
    expect(ancestryFrom({ equal: false, mainIsAncestorOfIntegration: false, integrationIsAncestorOfMain: true })).toBe(
      'main-ahead',
    );
  });
  test('neither ancestor → diverged', () => {
    expect(ancestryFrom({ equal: false, mainIsAncestorOfIntegration: false, integrationIsAncestorOfMain: false })).toBe(
      'diverged',
    );
  });
});

describe('decideRepo', () => {
  test('equal → none', () => {
    expect(decideRepo({ repo: 'ru', ancestry: 'equal', integrationGreen: true }, true)).toBe('none');
  });
  test('main-ahead → catch-up regardless of green/system', () => {
    expect(decideRepo({ repo: 'ru', ancestry: 'main-ahead', integrationGreen: false }, false)).toBe('catch-up');
    expect(decideRepo({ repo: 'ru', ancestry: 'main-ahead', integrationGreen: true }, true)).toBe('catch-up');
  });
  test('main-behind + green + systemGreen → promote', () => {
    expect(decideRepo({ repo: 'ru', ancestry: 'main-behind', integrationGreen: true }, true)).toBe('promote');
  });
  test('main-behind but integration red → hold-red (never promote a red main)', () => {
    expect(decideRepo({ repo: 'ru', ancestry: 'main-behind', integrationGreen: false }, true)).toBe('hold-red');
  });
  test('main-behind + own repo green but system NOT green → hold-red', () => {
    expect(decideRepo({ repo: 'ru', ancestry: 'main-behind', integrationGreen: true }, false)).toBe('hold-red');
  });
  test('diverged → diverged', () => {
    expect(decideRepo({ repo: 'ru', ancestry: 'diverged', integrationGreen: true }, true)).toBe('diverged');
  });

  test("main-behind + build green + smoke explicitly RED → hold-red (built but won't boot)", () => {
    expect(decideRepo({ repo: 'ru', ancestry: 'main-behind', integrationGreen: true, smokeGreen: false }, true)).toBe(
      'hold-red',
    );
  });
  test('main-behind + build green + smoke green + systemGreen → promote', () => {
    expect(decideRepo({ repo: 'ru', ancestry: 'main-behind', integrationGreen: true, smokeGreen: true }, true)).toBe(
      'promote',
    );
  });
  test('main-behind + build green + smoke undefined (no smoke ran) → promote (smoke never blocks unless it fails)', () => {
    expect(decideRepo({ repo: 'ru', ancestry: 'main-behind', integrationGreen: true }, true)).toBe('promote');
  });
});

describe('repoGreen', () => {
  test('build green + no smoke → green (smoke is optional)', () => {
    expect(repoGreen({ integrationGreen: true })).toBe(true);
  });
  test('build green + smoke green → green', () => {
    expect(repoGreen({ integrationGreen: true, smokeGreen: true })).toBe(true);
  });
  test('build green + smoke FAILED → NOT green (the runtime-only break the build missed)', () => {
    expect(repoGreen({ integrationGreen: true, smokeGreen: false })).toBe(false);
  });
  test('build red → not green regardless of smoke', () => {
    expect(repoGreen({ integrationGreen: false })).toBe(false);
    expect(repoGreen({ integrationGreen: false, smokeGreen: true })).toBe(false);
  });
});

describe('decideSystem', () => {
  test('all repos green + a behind repo → promote that repo, catch-up the ahead, none the equal', () => {
    const repos: RepoState[] = [
      { repo: 'cwip', ancestry: 'equal', integrationGreen: true },
      { repo: 'ru', ancestry: 'main-behind', integrationGreen: true },
      { repo: 'ca', ancestry: 'main-ahead', integrationGreen: true },
    ];
    const d = decideSystem(repos);
    expect(d.get('cwip')).toBe('none');
    expect(d.get('ru')).toBe('promote');
    expect(d.get('ca')).toBe('catch-up');
  });

  test('one red repo holds back ALL promotions but still allows catch-up', () => {
    const repos: RepoState[] = [
      { repo: 'cwip', ancestry: 'main-behind', integrationGreen: false }, // the red one
      { repo: 'ru', ancestry: 'main-behind', integrationGreen: true }, // green but blocked by system
      { repo: 'ca', ancestry: 'main-ahead', integrationGreen: true },
    ];
    const d = decideSystem(repos);
    expect(d.get('cwip')).toBe('hold-red');
    expect(d.get('ru')).toBe('hold-red'); // system not green → don't promote even though ru is green
    expect(d.get('ca')).toBe('catch-up'); // safe regardless of system health
  });

  test('empty system → no promotions (systemGreen is false on empty)', () => {
    expect(decideSystem([]).size).toBe(0);
  });

  test('a repo that BUILDS green but FAILS its boot smoke holds back ALL promotions', () => {
    const repos: RepoState[] = [
      // ca built fine but crashes on boot → smoke red → not promotable + drags the system red.
      { repo: 'ca', ancestry: 'main-behind', integrationGreen: true, smokeGreen: false },
      // ru is fully green (build + smoke) but is held because the system isn't all-green.
      { repo: 'ru', ancestry: 'main-behind', integrationGreen: true, smokeGreen: true },
      { repo: 'cwip', ancestry: 'main-ahead', integrationGreen: true },
    ];
    const d = decideSystem(repos);
    expect(d.get('ca')).toBe('hold-red'); // built but won't boot
    expect(d.get('ru')).toBe('hold-red'); // green, but system not all-green
    expect(d.get('cwip')).toBe('catch-up'); // safe regardless
  });
});

describe('integrationNeedsHeal', () => {
  test('red build → heal', () => {
    expect(integrationNeedsHeal({ integrationGreen: false })).toBe(true);
  });
  test('green build, no smoke → no heal', () => {
    expect(integrationNeedsHeal({ integrationGreen: true })).toBe(false);
  });
  test('green build but FAILED boot smoke → heal (runtime break)', () => {
    expect(integrationNeedsHeal({ integrationGreen: true, smokeGreen: false })).toBe(true);
  });
  test('green build + green smoke → no heal', () => {
    expect(integrationNeedsHeal({ integrationGreen: true, smokeGreen: true })).toBe(false);
  });
});

describe('healReason', () => {
  test('build failure → "build" (takes precedence)', () => {
    expect(healReason({ integrationGreen: false })).toBe('build');
    expect(healReason({ integrationGreen: false, smokeGreen: false })).toBe('build');
  });
  test('build green but smoke failed → "smoke" (takes precedence over render)', () => {
    expect(healReason({ integrationGreen: true, smokeGreen: false })).toBe('smoke');
    expect(healReason({ integrationGreen: true, smokeGreen: false, renderGreen: false })).toBe('smoke');
  });
  test('build + boot green but render failed (white screen) → "render"', () => {
    expect(healReason({ integrationGreen: true, smokeGreen: true, renderGreen: false })).toBe('render');
    expect(healReason({ integrationGreen: true, renderGreen: false })).toBe('render');
  });
  test('fully green → null', () => {
    expect(healReason({ integrationGreen: true })).toBeNull();
    expect(healReason({ integrationGreen: true, smokeGreen: true })).toBeNull();
    expect(healReason({ integrationGreen: true, smokeGreen: true, renderGreen: true })).toBeNull();
  });
});

describe('render smoke gate (anti white-screen)', () => {
  test('repoGreen: build + boot green but render FAILED → NOT green (the white screen build+boot missed)', () => {
    expect(repoGreen({ integrationGreen: true, smokeGreen: true, renderGreen: false })).toBe(false);
  });
  test('repoGreen: render undefined (inconclusive / no render ran) never blocks', () => {
    expect(repoGreen({ integrationGreen: true, smokeGreen: true })).toBe(true);
  });
  test('decideRepo: main-behind + build+boot green but render RED → hold-red', () => {
    expect(
      decideRepo(
        { repo: 'ru', ancestry: 'main-behind', integrationGreen: true, smokeGreen: true, renderGreen: false },
        true,
      ),
    ).toBe('hold-red');
  });
  test('decideSystem: a repo that BUILDS+BOOTS green but WHITE-SCREENS holds back ALL promotions', () => {
    const actions = decideSystem([
      { repo: 'ca', ancestry: 'main-behind', integrationGreen: true, smokeGreen: true, renderGreen: false },
      { repo: 'ru', ancestry: 'main-behind', integrationGreen: true, smokeGreen: true, renderGreen: true },
    ]);
    expect(actions.get('ca')).toBe('hold-red');
    expect(actions.get('ru')).toBe('hold-red'); // held because the system isn't all-green
  });
  test('integrationNeedsHeal: white-screened render → heal', () => {
    expect(integrationNeedsHeal({ integrationGreen: true, smokeGreen: true, renderGreen: false })).toBe(true);
  });
});

describe('decideCycle (anti-starvation: keep verifying + promoting while workers are active)', () => {
  test('no workers active → full cycle, run unsafe mutations, counter reset', () => {
    const d = decideCycle({ workersActive: false, consecutiveDeferrals: 4, forceFullEvery: 6 });
    expect(d.mode).toBe('full');
    expect(d.runUnsafeMutations).toBe(true);
    expect(d.nextConsecutiveDeferrals).toBe(0);
  });

  test('worker active, under the backstop → promote-safe, defer unsafe mutations, counter increments', () => {
    const d = decideCycle({ workersActive: true, consecutiveDeferrals: 0, forceFullEvery: 6 });
    expect(d.mode).toBe('promote-safe');
    expect(d.runUnsafeMutations).toBe(false);
    expect(d.nextConsecutiveDeferrals).toBe(1);
  });

  test('the counter keeps climbing across consecutive busy cycles', () => {
    expect(
      decideCycle({ workersActive: true, consecutiveDeferrals: 3, forceFullEvery: 6 }).nextConsecutiveDeferrals,
    ).toBe(4);
  });

  test('starvation backstop: once deferrals reach the threshold, force a full cycle (and reset)', () => {
    const d = decideCycle({ workersActive: true, consecutiveDeferrals: 6, forceFullEvery: 6 });
    expect(d.mode).toBe('full');
    expect(d.runUnsafeMutations).toBe(true);
    expect(d.nextConsecutiveDeferrals).toBe(0);
  });

  test('backstop also fires when deferrals exceed the threshold (e.g. after a config lowering)', () => {
    expect(decideCycle({ workersActive: true, consecutiveDeferrals: 9, forceFullEvery: 6 }).mode).toBe('full');
  });

  test('forceFullEvery <= 0 disables the backstop → stay promote-safe no matter how long busy', () => {
    const d = decideCycle({ workersActive: true, consecutiveDeferrals: 100, forceFullEvery: 0 });
    expect(d.mode).toBe('promote-safe');
    expect(d.runUnsafeMutations).toBe(false);
    expect(d.nextConsecutiveDeferrals).toBe(101);
  });
});

describe('isActionSafeWhileBusy (only catch-up races a worker landing on integration)', () => {
  test("promote is always safe — it ff's the promotion-only main branch to a verified SHA", () => {
    expect(isActionSafeWhileBusy('promote')).toBe(true);
  });
  test('none / hold-red / diverged perform no integration-branch mutation → safe', () => {
    expect(isActionSafeWhileBusy('none')).toBe(true);
    expect(isActionSafeWhileBusy('hold-red')).toBe(true);
    expect(isActionSafeWhileBusy('diverged')).toBe(true);
  });
  test("catch-up ff's the INTEGRATION branch a worker may be landing on → NOT safe while busy", () => {
    expect(isActionSafeWhileBusy('catch-up')).toBe(false);
  });
});

describe('promoteShaStillVerified (promote only the SHA we classified + built this cycle)', () => {
  test('tip unchanged since classification → still verified, promote may proceed', () => {
    expect(promoteShaStillVerified('abc123', 'abc123')).toBe(true);
  });
  test('a worker landed mid-cycle (tip moved) → NOT the SHA we built → defer the promote', () => {
    expect(promoteShaStillVerified('abc123', 'def456')).toBe(false);
  });
  test('empty/unknown classified SHA is never treated as verified', () => {
    expect(promoteShaStillVerified('', '')).toBe(false);
  });
});
