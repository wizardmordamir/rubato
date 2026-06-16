import { describe, expect, test } from 'bun:test';
import type { Step } from '../shared/automation';
import { cleanCapturedSteps } from './cleanSteps';

const fill = (id: string, value: string, valueMode?: 'secret' | 'env'): Step => ({
  id: `f-${id}`,
  action: 'fill',
  target: { kind: 'id', value: id },
  params: valueMode ? { value, valueMode } : { value },
});
const goto = (url: string): Step => ({ id: `g-${url}`, action: 'goto', params: { url } });
const click = (name: string): Step => ({
  id: `c-${name}`,
  action: 'click',
  target: { kind: 'role', value: 'button', name },
});

describe('cleanCapturedSteps', () => {
  test('drops an empty fill (types nothing) but keeps a non-empty one', () => {
    const out = cleanCapturedSteps([fill('email', 'me@x.com'), fill('password', '')]);
    expect(out).toEqual([fill('email', 'me@x.com')]);
  });

  test('drops an empty SECRET fill — the exact noise that stalled the captured login replay', () => {
    // capture: …fill #password (real) … goto / … fill #password "" (secret) → fails on /
    const out = cleanCapturedSteps([
      fill('email', 'me@x.com'),
      fill('password', 'hunter2', 'secret'),
      goto('https://app/'),
      fill('password', '', 'secret'),
      click('Continue'),
    ]);
    expect(out).toEqual([
      fill('email', 'me@x.com'),
      fill('password', 'hunter2', 'secret'),
      goto('https://app/'),
      click('Continue'),
    ]);
  });

  test('keeps an env-mode fill (its value is the variable NAME, not empty)', () => {
    const out = cleanCapturedSteps([fill('password', 'CA_PASSWORD', 'env')]);
    expect(out).toEqual([fill('password', 'CA_PASSWORD', 'env')]);
  });

  test('keeps a fill whose value is an unresolved ${VAR} (non-empty literal)', () => {
    const out = cleanCapturedSteps([fill('user', '${USERNAME}')]);
    expect(out).toEqual([fill('user', '${USERNAME}')]);
  });

  test('collapses consecutive gotos to the same URL, keeping distinct ones', () => {
    const out = cleanCapturedSteps([goto('https://app/'), goto('https://app/'), goto('https://app/next')]);
    expect(out).toEqual([goto('https://app/'), goto('https://app/next')]);
  });

  test('does not collapse a repeated goto separated by another step', () => {
    const out = cleanCapturedSteps([goto('https://app/'), click('Go'), goto('https://app/')]);
    expect(out).toEqual([goto('https://app/'), click('Go'), goto('https://app/')]);
  });

  test('leaves a clean step list untouched', () => {
    const steps = [goto('https://app/login'), fill('email', 'me@x.com'), click('Sign in')];
    expect(cleanCapturedSteps(steps)).toEqual(steps);
  });
});
