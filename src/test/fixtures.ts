/**
 * Fixture builders — terse, overridable constructors for the domain objects tests
 * keep hand-rolling. Each takes a partial override so a test states only what it
 * cares about (`aDeployEntry({ sha256: "bad" })`).
 */

import type { DeployEntry } from '../api/deploy/types';
import type { AppApi } from '../lib/appApis';
import type { AppConfig } from '../lib/apps';

/** A registry app. Defaults to a bare named-path entry; pass `apis` for integrations. */
export function anApp(name: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    name,
    absolutePath: `/tmp/${name}`,
    dirName: name,
    repoName: name,
    group: null,
    aliases: [],
    ...over,
  };
}

/** Shorthand for an app's `apis` array. */
export function withApis(name: string, apis: AppApi[], over: Partial<AppConfig> = {}): AppConfig {
  return anApp(name, { apis, ...over });
}

/** A parsed deploy-list entry (PASS-shaped by default; override to break it). */
export function aDeployEntry(over: Partial<DeployEntry> = {}): DeployEntry {
  return {
    app: 'app',
    version: '1.2.3',
    commit: 'abc123',
    sha256: 'deadbeef',
    sourceLine: 1,
    ...over,
  };
}
