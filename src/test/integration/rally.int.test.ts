/**
 * Integration: the Rally routes are credential-gated. With no RALLY_* creds (the
 * test env has none) every endpoint returns 412 `needsCreds` — fully wired, just
 * waiting on creds. The client's request logic is unit-tested with a mocked fetch.
 */

import { describe, expect, test } from 'bun:test';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

describe('rally routes (no creds → 412)', () => {
  test('story/task/update all degrade to 412 needsCreds without RALLY_*', async () => {
    for (const res of [
      await apiGet('/api/rally/story/US123'),
      await apiGet('/api/rally/task/TA456'),
      await apiPost('/api/rally/task/TA456/update', { state: 'In-Progress', notes: 'x' }),
    ]) {
      expect(res.status).toBe(412);
      // Canonical envelope: extras like needsCreds ride in error.context.
      const body = (await res.json()) as { error: { context?: { needsCreds?: boolean } } };
      expect(body.error.context?.needsCreds).toBe(true);
    }
  });
});
