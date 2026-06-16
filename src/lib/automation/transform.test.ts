import { describe, expect, it } from 'bun:test';
import type { Automation, Step } from '../../shared/automation';
import { rebaseAutomationUrls } from './transform';

const build = (steps: Step[], over: Partial<Automation> = {}): Automation => ({
  id: 'a1',
  name: 'flow',
  startUrl: 'https://chat.staging.example.com/login?ref=x',
  steps,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('rebaseAutomationUrls', () => {
  it('makes startUrl relative by default (origin from startUrl)', () => {
    const out = rebaseAutomationUrls(build([]));
    expect(out.startUrl).toBe('/login?ref=x');
  });

  it('rebases onto a new origin when `to` is given', () => {
    const out = rebaseAutomationUrls(build([]), { to: 'http://localhost:5080/' });
    expect(out.startUrl).toBe('http://localhost:5080/login?ref=x');
  });

  it('rewrites newTab navigation URLs the same as goto', () => {
    const out = rebaseAutomationUrls(
      build([{ id: 's1', action: 'newTab', params: { url: 'https://chat.staging.example.com/reports' } }]),
    );
    expect(out.steps[0].params?.url).toBe('/reports');
  });

  it('rewrites goto steps from the same origin, including nested if branches', () => {
    const out = rebaseAutomationUrls(
      build([
        { id: 's1', action: 'goto', params: { url: 'https://chat.staging.example.com/settings' } },
        {
          id: 's2',
          action: 'if',
          condition: { kind: 'url-matches', value: '/settings' },
          thenSteps: [{ id: 's3', action: 'goto', params: { url: 'https://chat.staging.example.com/profile' } }],
        },
      ]),
    );
    expect(out.steps[0].params?.url).toBe('/settings');
    expect(out.steps[1].thenSteps?.[0].params?.url).toBe('/profile');
  });

  it('leaves a goto to a different host untouched', () => {
    const out = rebaseAutomationUrls(
      build([{ id: 's1', action: 'goto', params: { url: 'https://accounts.google.com/oauth' } }]),
    );
    expect(out.steps[0].params?.url).toBe('https://accounts.google.com/oauth');
  });

  it('accepts an explicit `from` origin (scheme-less ok) and a list', () => {
    const out = rebaseAutomationUrls(build([], { startUrl: 'old.example.com/home' }), {
      from: ['old.example.com', 'other.example.com'],
    });
    expect(out.startUrl).toBe('/home');
  });

  it('does not mangle interpolated URLs', () => {
    const out = rebaseAutomationUrls(
      build([{ id: 's1', action: 'goto', params: { url: 'https://chat.staging.example.com/${scraped.path}' } }]),
    );
    expect(out.steps[0].params?.url).toBe('https://chat.staging.example.com/${scraped.path}');
  });

  it('does not mutate the input automation', () => {
    const input = build([{ id: 's1', action: 'goto', params: { url: 'https://chat.staging.example.com/x' } }]);
    rebaseAutomationUrls(input);
    expect(input.startUrl).toBe('https://chat.staging.example.com/login?ref=x');
    expect(input.steps[0].params?.url).toBe('https://chat.staging.example.com/x');
  });
});
