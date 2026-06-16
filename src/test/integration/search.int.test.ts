/**
 * Integration: GET /api/search through `route()` — that authored items are found
 * and grouped, that a body-only match surfaces a snippet, that an empty query is a
 * no-op, and that LIKE wildcards in the query are matched literally (escaped).
 */

import { describe, expect, test } from 'bun:test';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

interface SearchHit {
  id: string;
  title: string;
  snippet?: string;
  sub?: string;
  href: string;
}
interface SearchGroup {
  key: string;
  label: string;
  href: string;
  items: SearchHit[];
}

const search = async (q: string): Promise<SearchGroup[]> => {
  const res = await apiGet(`/api/search?q=${encodeURIComponent(q)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { groups: SearchGroup[] }).groups;
};

describe('content search', () => {
  test('finds authored items, groups them in order, and snippets a body-only match', async () => {
    await apiPost('/api/plans', {
      title: 'Quarterly plan',
      app: 'billing',
      content: '# Plan\n- upgrade zlibfoo to patch the CVE',
    });
    await apiPost('/api/board', {
      title: 'zlibfoo upgrade card',
      description: 'do it',
      notes: '',
      links: [],
      images: [],
      status: 'ready',
      position: 1,
    });

    const groups = await search('zlibfoo');
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));

    // Board card matched in its title (so no redundant snippet); it links to /board.
    const card = byKey.board?.items.find((i) => i.title === 'zlibfoo upgrade card');
    expect(card).toBeTruthy();
    expect(card?.href).toBe('/board');

    // The plan matched only in its body → a snippet surfaces *why* it matched.
    const plan = byKey.plans?.items.find((i) => i.title === 'Quarterly plan');
    expect(plan).toBeTruthy();
    expect(plan?.snippet?.toLowerCase()).toContain('zlibfoo');
    expect(plan?.href).toBe('/plans');

    // Groups follow the declared order (board before plans).
    const idx = (k: string) => groups.findIndex((g) => g.key === k);
    expect(idx('board')).toBeLessThan(idx('plans'));
  });

  test('an empty / whitespace query returns no groups', async () => {
    expect(await search('   ')).toEqual([]);
  });

  test('LIKE wildcards in the query are matched literally (escaped)', async () => {
    await apiPost('/api/plans', { title: 'literal zz_zz token', app: 'x', content: 'x' });
    await apiPost('/api/plans', { title: 'zzqzz lookalike', app: 'x', content: 'x' });

    const titles = (await search('zz_zz')).find((g) => g.key === 'plans')?.items.map((i) => i.title) ?? [];
    expect(titles).toContain('literal zz_zz token');
    // '_' must be a literal underscore, NOT a single-char wildcard (which would also
    // match "zzqzz").
    expect(titles).not.toContain('zzqzz lookalike');
  });
});
