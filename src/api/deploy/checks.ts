/**
 * The pure verification engine: given one deploy-list entry and a set of
 * already-bound capability callbacks (one per service, scoped to the entry's
 * app), run the integrity checks and produce a VerifyResult.
 *
 * Confidence-tiered, by design (the data forced this — see version.ts):
 *   HARD (issue ⇒ FAIL):  Quay tag exists · its digest == the list sha256 ·
 *                         the git commit exists
 *   SOFT (warning only):  build correlation, build result, commit-in-build,
 *                         and every "service not configured" case
 *
 * Pure: no network, no config, no process. The caller injects the capabilities
 * (lib/deploy/verify.ts wires them to the live clients) and a clock.
 */

import { getBuildCommits } from '../jenkins/filters';
import type { JenkinsBuild } from '../jenkins/types';
import type { QuayTag } from '../quay';
import type { GitMeta, JenkinsMeta, QuayMeta, VerifyResult } from './types';

/** A git commit, as much as the engine needs. */
export interface CommitInfo {
  message?: string;
  author?: string;
  date?: string;
}

/**
 * Capabilities the engine calls, each already scoped to the entry's app. An
 * absent capability means that service isn't configured for the app → a warning,
 * never a crash. Each may throw; the engine catches and downgrades to a warning.
 */
export interface EntryClients {
  /** The Quay tag literally named `version`, or null if none. */
  quayTag?: (version: string) => Promise<QuayTag | null>;
  /** Best-effort Jenkins build for `version`, with how it was matched. */
  jenkinsBuild?: (version: string) => Promise<{ build: JenkinsBuild | null; strategy: string }>;
  /** The git commit for `sha`, or null if it doesn't exist. */
  gitCommit?: (sha: string) => Promise<CommitInfo | null>;
}

export interface VerifyContext {
  /** Did the entry's app label resolve to a registered app? */
  registryMatched: boolean;
  clients: EntryClients;
  /** Clock for the verification timestamp (injectable for tests). */
  now?: () => number;
}

function bareDigest(digest: string | undefined): string | null {
  return digest ? digest.replace(/^sha256:/i, '').toLowerCase() : null;
}

/** Verify one deploy-list entry. FAIL iff any hard issue is found. */
export async function verifyEntry(
  entry: { app: string; version: string; commit?: string; sha256: string },
  ctx: VerifyContext,
): Promise<VerifyResult> {
  const issues: string[] = [];
  const warnings: string[] = [];
  const at = new Date(ctx.now ? ctx.now() : Date.now()).toISOString();
  let quayData: QuayMeta | undefined;
  let jenkinsData: JenkinsMeta | undefined;
  let gitData: GitMeta | undefined;

  if (!ctx.registryMatched) {
    warnings.push(`app "${entry.app}" not found in registry — limited verification`);
  }

  // ── Quay: image integrity (the critical hard checks) ──────────────────────
  if (ctx.clients.quayTag) {
    try {
      const tag = await ctx.clients.quayTag(entry.version);
      if (!tag) {
        issues.push(`Quay tag "${entry.version}" not found`);
      } else {
        quayData = {
          tagName: tag.name,
          tagTimestamp: tag.last_modified,
          tagSize: tag.size,
          tagManifestDigest: tag.manifest_digest,
        };
        const digest = bareDigest(tag.manifest_digest);
        if (digest && digest !== entry.sha256) {
          issues.push(`sha256 mismatch: list ${entry.sha256} vs Quay ${digest}`);
        } else if (!digest) {
          warnings.push(`Quay tag "${entry.version}" has no manifest digest to compare`);
        }
      }
    } catch (err) {
      warnings.push(`Quay check failed: ${(err as Error).message}`);
    }
  } else {
    warnings.push('Quay not configured for this app — image digest not verified');
  }

  // ── Git: the commit must exist ────────────────────────────────────────────
  if (ctx.clients.gitCommit) {
    if (!entry.commit) {
      warnings.push('no commit in list entry — commit not verified');
    } else {
      try {
        const commit = await ctx.clients.gitCommit(entry.commit);
        if (!commit) {
          issues.push(`commit ${entry.commit} does not exist in git`);
        } else {
          gitData = { commitMessage: commit.message, commitAuthor: commit.author, commitDate: commit.date };
        }
      } catch (err) {
        warnings.push(`Git check failed: ${(err as Error).message}`);
      }
    }
  } else if (entry.commit) {
    warnings.push('Git not configured for this app — commit existence not verified');
  }

  // ── Jenkins: best-effort build enrichment (never a hard gate) ─────────────
  if (ctx.clients.jenkinsBuild) {
    try {
      const { build, strategy } = await ctx.clients.jenkinsBuild(entry.version);
      if (!build) {
        warnings.push(`no Jenkins build found for version ${entry.version}`);
      } else {
        jenkinsData = {
          buildNumber: build.number,
          buildTimestamp: build.timestamp,
          buildTimestampIso: new Date(build.timestamp).toISOString(),
          buildUrl: build.url,
          buildDuration: build.duration,
          buildResult: build.result,
          matchStrategy: strategy,
        };
        if (strategy === 'buildNumber') {
          warnings.push(`matched build #${build.number} by build-number heuristic (low confidence)`);
        }
        if (build.result !== 'SUCCESS') {
          warnings.push(`producing build #${build.number} result is ${build.result ?? 'in-progress'}`);
        }
        if (entry.commit) {
          const inBuild = getBuildCommits(build).some((id) => id.toLowerCase().startsWith(entry.commit!.toLowerCase()));
          if (!inBuild) warnings.push(`commit ${entry.commit} not among build #${build.number} commits`);
        }
      }
    } catch (err) {
      warnings.push(`Jenkins check failed: ${(err as Error).message}`);
    }
  }

  return {
    app: entry.app,
    version: entry.version,
    commit: entry.commit,
    sha256: entry.sha256,
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    issues,
    warnings,
    metadata: { verificationTimestamp: at, jenkinsData, quayData, gitData },
  };
}
