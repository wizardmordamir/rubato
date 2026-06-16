/**
 * One-call test setup. Drop `useHarness()` (in-process) or `useFunctional()`
 * (real server subprocess) at the top of a describe block and it wires the
 * beforeAll/afterAll lifecycle: start the fake upstream, seed an isolated home,
 * (optionally) boot the server, and tear it all down. Returns lazy accessors —
 * read `h.fake`/`h.seed`/`h.server` inside your tests, after setup has run.
 *
 *   const h = useHarness();
 *   test("...", async () => {
 *     const res = await apiPost("/api/splunk/run", { app: "app", env: "prod" });
 *     expect(h.fake.requests.some((r) => r.service === "splunk")).toBe(true);
 *   });
 */

import { afterAll, beforeAll } from 'bun:test';
import { route } from '../server/router';
import { type FakeUpstream, startFakeUpstream } from './fakeUpstream';
import { type SeededHome, type SeedOptions, seedHome } from './seed';
import { type StartServerOptions, startTestServer, type TestServer } from './server';

export interface Harness {
  readonly fake: FakeUpstream;
  readonly seed: SeededHome;
}

export interface FunctionalHarness extends Harness {
  readonly server: TestServer;
}

/** In-process harness: fake upstream + seeded home, driven via `route()`/`api*`. */
export function useHarness(opts: SeedOptions = {}): Harness {
  let fake: FakeUpstream | undefined;
  let seed: SeededHome | undefined;

  beforeAll(async () => {
    fake = startFakeUpstream();
    seed = await seedHome(fake.url, opts);
  });
  afterAll(async () => {
    seed?.cleanup();
    await fake?.stop();
  });

  return {
    get fake() {
      if (!fake) throw new Error('useHarness: fake not ready (read it inside a test, not at module scope)');
      return fake;
    },
    get seed() {
      if (!seed) throw new Error('useHarness: seed not ready (read it inside a test, not at module scope)');
      return seed;
    },
  };
}

/** Functional harness: everything `useHarness` does, plus a real rubato-serve. */
export function useFunctional(opts: SeedOptions & StartServerOptions = {}): FunctionalHarness {
  let fake: FakeUpstream | undefined;
  let seed: SeededHome | undefined;
  let server: TestServer | undefined;

  beforeAll(async () => {
    fake = startFakeUpstream();
    seed = await seedHome(fake.url, opts);
    server = await startTestServer(opts);
  });
  afterAll(async () => {
    await server?.stop();
    seed?.cleanup();
    await fake?.stop();
  });

  const need = <T>(v: T | undefined, what: string): T => {
    if (!v) throw new Error(`useFunctional: ${what} not ready (read it inside a test)`);
    return v;
  };

  return {
    get fake() {
      return need(fake, 'fake');
    },
    get seed() {
      return need(seed, 'seed');
    },
    get server() {
      return need(server, 'server');
    },
  };
}

// ── In-process route() helpers ───────────────────────────────────────────────

/** GET a path on the in-process `route()` handler. */
export const apiGet = (path: string): Promise<Response> => route(new Request(`http://x${path}`));

/** POST JSON to the in-process `route()` handler. */
export const apiPost = (path: string, body: unknown): Promise<Response> =>
  route(new Request(`http://x${path}`, { method: 'POST', body: JSON.stringify(body) }));

/** PATCH JSON to the in-process `route()` handler. */
export const apiPatch = (path: string, body: unknown): Promise<Response> =>
  route(new Request(`http://x${path}`, { method: 'PATCH', body: JSON.stringify(body) }));

/** Fetch + parse JSON, asserting nothing — caller checks status separately if needed. */
export async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
