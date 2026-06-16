/**
 * Testkit barrel — the one import a test reaches for. Setup helpers, the fake
 * upstream, seeding, fixtures, and the in-process `route()` helpers.
 *
 *   import { useHarness, apiPost, aDeployEntry } from "../index";
 *
 * (The `setup.ts` preload that isolates RUBATO_HOME is wired in bunfig.toml and
 * isn't imported by tests.)
 */

export { type FakeContext, type FakeUpstream, type RecordedRequest, startFakeUpstream } from './fakeUpstream';
export { aDeployEntry, anApp, withApis } from './fixtures';
export {
  apiGet,
  apiPatch,
  apiPost,
  type FunctionalHarness,
  type Harness,
  jsonOf,
  useFunctional,
  useHarness,
} from './harness';
export { resetRubatoState } from './reset';
export { type SeededHome, type SeedOptions, seedHome } from './seed';
export { type StartServerOptions, startTestServer, type TestServer } from './server';
