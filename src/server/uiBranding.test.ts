/**
 * Runtime UI branding — re-theme/re-title the prebuilt SPA's index.html without a
 * rebuild. A friend app sets `startApp({ ui: { accent, brand } })`.
 */

import { describe, expect, test } from 'bun:test';
import { injectBranding } from './router';

const HTML = `<!doctype html><html><head><title>rubato</title><link rel="stylesheet" href="/a.css"></head><body><div id="root"></div></body></html>`;

describe('injectBranding', () => {
  test('overrides the --accent token from a single accent color', () => {
    const out = injectBranding(HTML, { accent: '#e11d48' });
    expect(out).toContain('data-rubato-theme');
    expect(out).toContain('--accent:#e11d48');
    expect(out).toContain('--accent-hover:color-mix(in srgb, #e11d48 85%, black)');
    expect(out).toContain('.dark{--accent:color-mix(in srgb, #e11d48 72%, white)');
    // Injected at the end of <head> so it wins over the linked theme CSS.
    expect(out.indexOf('data-rubato-theme')).toBeGreaterThan(out.indexOf('/a.css'));
  });

  test('sets the browser tab title from `brand`', () => {
    expect(injectBranding(HTML, { brand: 'QA Studio' })).toContain('<title>QA Studio</title>');
    expect(injectBranding(HTML, { brand: 'QA Studio' })).not.toContain('<title>rubato</title>');
  });

  test('emits the app-brand meta so the in-app wordmark re-brands too', () => {
    expect(injectBranding(HTML, { brand: 'FlowSmith' })).toContain('<meta name="app-brand" content="FlowSmith">');
  });

  test('honors explicit hover/soft overrides', () => {
    const out = injectBranding(HTML, { accent: '#000', accentHover: '#111', accentSoft: '#eee' });
    expect(out).toContain('--accent-hover:#111');
    expect(out).toContain('--accent-soft:#eee');
  });

  test('rejects a malformed accent (no CSS/script breakout)', () => {
    const out = injectBranding(HTML, { accent: 'red;}</style><script>alert(1)</script>' });
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('data-rubato-theme'); // safeColor rejected → no style emitted
  });

  test('escapes the brand title', () => {
    expect(injectBranding(HTML, { brand: '<b>x</b>' })).toContain('<title>&lt;b&gt;x&lt;/b&gt;</title>');
  });

  test('empty branding is a no-op', () => {
    expect(injectBranding(HTML, {})).toBe(HTML);
  });

  test('showSearch:false injects the app-search meta', () => {
    expect(injectBranding(HTML, { showSearch: false })).toContain('<meta name="app-search" content="0">');
  });

  test('showSearch:true does not inject the app-search meta', () => {
    expect(injectBranding(HTML, { showSearch: true })).not.toContain('app-search');
    expect(injectBranding(HTML, { showSearch: true })).toBe(HTML);
  });
});
