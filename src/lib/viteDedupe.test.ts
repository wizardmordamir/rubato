import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkDedupeSource,
  checkReactDedupe,
  extractDedupeFromSource,
  formatDedupeCheck,
  REQUIRED_REACT_DEDUPE,
} from './viteDedupe';

describe('checkReactDedupe', () => {
  it('passes when every required React subpath is present', () => {
    const r = checkReactDedupe([...REQUIRED_REACT_DEDUPE, '@tanstack/react-query', 'zustand']);
    expect(r.ok).toBe(true);
    expect(r.missingRequired).toEqual([]);
    expect(r.missingRecommended).toEqual([]);
  });

  it('FAILS (and names the gap) when a React subpath is missing — the dev-only white-screen', () => {
    const r = checkReactDedupe(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']); // no jsx-dev-runtime
    expect(r.ok).toBe(false);
    expect(r.missingRequired).toEqual(['react/jsx-dev-runtime']);
  });

  it('flags every missing required entry', () => {
    expect(checkReactDedupe(['react']).missingRequired).toEqual([
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
    ]);
  });

  it('treats null/empty as all-missing (a config with no dedupe)', () => {
    expect(checkReactDedupe(null).ok).toBe(false);
    expect(checkReactDedupe([]).missingRequired.length).toBe(REQUIRED_REACT_DEDUPE.length);
  });

  it('warns (not fails) on missing recommended context libs', () => {
    const r = checkReactDedupe([...REQUIRED_REACT_DEDUPE]);
    expect(r.ok).toBe(true);
    expect(r.missingRecommended).toEqual(['@tanstack/react-query', 'zustand']);
  });

  it('honors a custom recommended set', () => {
    const r = checkReactDedupe([...REQUIRED_REACT_DEDUPE, 'recharts'], ['recharts', 'lucide-react']);
    expect(r.missingRecommended).toEqual(['lucide-react']);
  });
});

describe('extractDedupeFromSource', () => {
  it('pulls quoted entries out of a dedupe array (with comments + mixed quotes)', () => {
    const src = `resolve: {
      // force single instances
      dedupe: [
        "react",
        'react-dom', // mixed quotes
        "react/jsx-dev-runtime",
      ],
    }`;
    expect(extractDedupeFromSource(src)).toEqual(['react', 'react-dom', 'react/jsx-dev-runtime']);
  });

  it('returns null when there is no dedupe block at all', () => {
    expect(extractDedupeFromSource('resolve: { alias: {} }')).toBeNull();
  });
});

describe('checkDedupeSource', () => {
  it('reports found=false when no dedupe block exists', () => {
    const r = checkDedupeSource('export default {}');
    expect(r.found).toBe(false);
    expect(r.ok).toBe(false);
  });
  it('checks an inline source', () => {
    const r = checkDedupeSource(`dedupe: [${REQUIRED_REACT_DEDUPE.map((x) => `"${x}"`).join(',')}]`);
    expect(r.found).toBe(true);
    expect(r.ok).toBe(true);
  });
});

describe('formatDedupeCheck', () => {
  it('summarizes pass/warn/fail distinctly', () => {
    expect(formatDedupeCheck('ru', { ok: true, missingRequired: [], missingRecommended: [] })).toContain('✓');
    expect(formatDedupeCheck('ru', { ok: true, missingRequired: [], missingRecommended: ['zustand'] })).toContain('⚠');
    expect(
      formatDedupeCheck('ru', { ok: false, missingRequired: ['react/jsx-dev-runtime'], missingRecommended: [] }),
    ).toContain('✗');
  });
});

// ── GUARDRAIL: ru's own ui/vite.config.ts must keep its React dedupe complete ──
// This is the anti-drift check itself: if a future edit drops a React subpath from
// resolve.dedupe (the exact gap that white-screened ru), THIS test fails the gate.
describe('GUARDRAIL: ru ui/vite.config.ts dedupe completeness', () => {
  const viteConfigPath = fileURLToPath(new URL('../../ui/vite.config.ts', import.meta.url));

  it('declares a resolve.dedupe block', () => {
    const src = readFileSync(viteConfigPath, 'utf8');
    expect(extractDedupeFromSource(src)).not.toBeNull();
  });

  it('covers every required React subpath (no dev-only white-screen gap)', () => {
    const src = readFileSync(viteConfigPath, 'utf8');
    const check = checkDedupeSource(src);
    // The assertion message names exactly what's missing, so a failure is actionable.
    expect(check.missingRequired).toEqual([]);
    expect(check.ok).toBe(true);
  });
});
