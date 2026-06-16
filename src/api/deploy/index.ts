/**
 * Deploy-list generation & verification primitives (pure / client-injected).
 * The IO glue that wires these to live clients + the registry lives in
 * src/lib/deploy/.
 */

export { type CommitInfo, type EntryClients, type VerifyContext, verifyEntry } from './checks';
export {
  effectiveVersionStrategy,
  type MatchStrategy,
  type ResolveBuildOptions,
  type ResolveBuildResult,
  resolveBuildForVersion,
  resolveQuayTagForVersion,
} from './resolve';
export type {
  DeployEntry,
  GitMeta,
  JenkinsMeta,
  QuayMeta,
  VerifyMetadata,
  VerifyReport,
  VerifyResult,
} from './types';
export { buildNumberFromVersion, parseVersion, versionFromBuild } from './version';
