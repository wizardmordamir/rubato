import { describe, expect, test } from 'bun:test';
import { ancestryFrom, decideRepo, decideSystem, integrationNeedsHeal, type RepoState } from './promote';

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
});

describe('integrationNeedsHeal', () => {
  test('red integration → heal', () => {
    expect(integrationNeedsHeal({ integrationGreen: false })).toBe(true);
  });
  test('green integration → no heal', () => {
    expect(integrationNeedsHeal({ integrationGreen: true })).toBe(false);
  });
});
