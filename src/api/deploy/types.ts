/**
 * Types for deploy-list generation and verification.
 *
 * A "deploy list" pins, per app, the exact artifact that should go to prod:
 *   app / version / commit / sha256(image digest)
 *
 * These lists are hand-maintained, so a single typo (a sha256 that doesn't match
 * the image, a commit that doesn't exist) can break a production deploy. The
 * verifier cross-checks each entry against the live systems that are the actual
 * source of truth (Quay for the image, GitLab for the commit, Jenkins for build
 * enrichment) and reports per-entry PASS/FAIL.
 */

import type { BuildResult } from '../jenkins/types';

/** One parsed entry from a hand-maintained deploy list. */
export interface DeployEntry {
  /** App label as written in the list (e.g. "team/my-app"); resolved via the registry. */
  app: string;
  /** Release version, which is also the Quay tag name (e.g. "1.1.13.739"). */
  version: string;
  /** Git commit the version was built from (40-hex; optional on image-only lines). */
  commit?: string;
  /** Image digest, normalized to bare lowercase hex (no "sha256:" prefix). */
  sha256: string;
  /** Raw date text if the list carried one (e.g. "6-9 7:49"). */
  date?: string;
  /** 1-based line number in the source file, for error messages. */
  sourceLine: number;
}

/** Jenkins build enrichment for a verified entry (best-effort — see resolve.ts). */
export interface JenkinsMeta {
  buildNumber: number;
  buildTimestamp: number;
  buildTimestampIso: string;
  buildUrl: string;
  buildDuration?: number;
  buildResult: BuildResult;
  /** How the build was matched ("param" | "displayName" | "buildNumber"); flags low-confidence matches. */
  matchStrategy: string;
}

/** Quay tag enrichment for a verified entry. */
export interface QuayMeta {
  tagName: string;
  tagTimestamp?: string;
  tagSize?: number;
  tagManifestDigest?: string;
}

/** Git commit enrichment for a verified entry. */
export interface GitMeta {
  commitMessage?: string;
  commitAuthor?: string;
  commitDate?: string;
}

export interface VerifyMetadata {
  verificationTimestamp: string;
  jenkinsData?: JenkinsMeta;
  quayData?: QuayMeta;
  gitData?: GitMeta;
}

/** Result of verifying one deploy-list entry. FAIL iff `issues` is non-empty. */
export interface VerifyResult {
  app: string;
  version: string;
  commit?: string;
  sha256: string;
  status: 'PASS' | 'FAIL';
  /** Hard problems that fail the entry (e.g. image digest mismatch). */
  issues: string[];
  /** Soft problems that flag but don't fail (e.g. couldn't pin the build). */
  warnings: string[];
  metadata: VerifyMetadata;
}

/** A full verification report over a deploy list. */
export interface VerifyReport {
  timestamp: string;
  summary: {
    listPath?: string;
    totalEntries: number;
    passed: number;
    failed: number;
    totalIssues: number;
    totalWarnings: number;
  };
  results: VerifyResult[];
}
