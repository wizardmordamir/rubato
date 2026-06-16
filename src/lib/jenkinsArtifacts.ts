/**
 * Download a Jenkins build's artifacts (default: PDFs) — the reusable core of the
 * `jenkins-fetch` pipeline script, kept apart from config/fs so it's testable
 * with a fake client + writer. Resolves a build, lists its artifacts, filters by
 * a filename pattern, and streams each match to a caller-supplied `write`.
 *
 * Pairs with `appscan-pdf`: jenkins-fetch downloads the ASoC report PDFs, then
 * appscan-pdf parses them into the vulnerabilities table.
 */

import { basename } from 'node:path';
import type { JenkinsArtifact, JenkinsBuild } from '../api/jenkins/types';

/** The slice of the Jenkins client `fetchJenkinsArtifacts` needs (injectable for tests). */
export interface JenkinsArtifactSource {
  getBuild(jobPath: string, selector: number | string): Promise<JenkinsBuild>;
  getArtifacts(jobPath: string, buildNumber: number): Promise<JenkinsArtifact[]>;
  downloadArtifact(
    jobPath: string,
    buildNumber: number,
    relativePath: string,
  ): Promise<ReadableStream<Uint8Array> | null>;
}

export interface FetchArtifactsOptions {
  jobPath: string;
  /** Build number, or a selector like "lastSuccessfulBuild" (default). */
  build?: number | string;
  /** RegExp source matched against each artifact's fileName/relativePath (default `\.pdf$`, case-insensitive). */
  match?: string;
  /** Persist a downloaded artifact; returns when written. The name is the (flattened) file name. */
  write: (name: string, bytes: Uint8Array) => Promise<void>;
}

export interface FetchArtifactsResult {
  buildNumber: number;
  /** Artifacts that matched the pattern (before download). */
  matched: string[];
  /** File names actually written (a matched artifact with no stream is skipped). */
  written: string[];
}

const DEFAULT_BUILD = 'lastSuccessfulBuild';
const DEFAULT_MATCH = '\\.pdf$';

/** Parse a build param into a number (numeric string) or a selector string. */
export function parseBuildSelector(value: number | string | undefined): number | string {
  if (value === undefined || value === '') return DEFAULT_BUILD;
  if (typeof value === 'number') return value;
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : value.trim();
}

export async function fetchJenkinsArtifacts(
  client: JenkinsArtifactSource,
  options: FetchArtifactsOptions,
): Promise<FetchArtifactsResult> {
  const build = await client.getBuild(options.jobPath, parseBuildSelector(options.build));
  const re = new RegExp(options.match || DEFAULT_MATCH, 'i');
  const artifacts = await client.getArtifacts(options.jobPath, build.number);
  const matched = artifacts.filter((a) => re.test(a.fileName) || re.test(a.relativePath));

  const written: string[] = [];
  const seen = new Set<string>();
  for (const artifact of matched) {
    const stream = await client.downloadArtifact(options.jobPath, build.number, artifact.relativePath);
    if (!stream) continue;
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    // Flatten relativePath → base name; de-dupe collisions with a numeric suffix.
    let name = basename(artifact.fileName || artifact.relativePath);
    if (seen.has(name)) {
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      let n = 2;
      while (seen.has(`${stem}-${n}${ext}`)) n++;
      name = `${stem}-${n}${ext}`;
    }
    seen.add(name);
    await options.write(name, bytes);
    written.push(name);
  }

  return { buildNumber: build.number, matched: matched.map((a) => a.relativePath), written };
}
