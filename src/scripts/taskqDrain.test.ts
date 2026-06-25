import { describe, expect, test } from 'bun:test';
import { isApiReachable } from './taskqDrain';

// The connectivity gate that prevents a network outage from burning a task's retry
// budget. `isApiReachable` is the only branch logic worth pinning: any HTTP response =
// the network path is up; a throw or a non-response = offline (skip the tick).
describe('isApiReachable (connectivity gate)', () => {
  test('any HTTP response (even an unauthenticated 401) counts as reachable', async () => {
    const fetcher = (async () => ({ status: 401 })) as unknown as typeof fetch;
    expect(await isApiReachable(1000, fetcher)).toBe(true);
  });

  test('a network-level throw (DNS/refused/timeout) counts as offline', async () => {
    const fetcher = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.anthropic.com');
    }) as unknown as typeof fetch;
    expect(await isApiReachable(1000, fetcher)).toBe(false);
  });

  test('a zero/no-status response counts as offline', async () => {
    const fetcher = (async () => ({ status: 0 })) as unknown as typeof fetch;
    expect(await isApiReachable(1000, fetcher)).toBe(false);
  });
});
