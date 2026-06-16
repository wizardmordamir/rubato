/**
 * Parse hand-maintained deploy lists into structured entries.
 *
 * Three layouts are accepted (all rubato-native, all tolerated by one parser):
 *
 *   block:        team/my-app 1.1.13.739
 *                 commit a1c32a44...
 *                 sha256:617b85b6...
 *
 *   dated:        team/my-consumer 1.1.1.536 (6-9 7:49)
 *                 commit: e4f42275...
 *                 sha256:81c349c8...
 *
 *   single-line:  team/my-monitor 1.6.3.701 sha256:66de3b80...   (no commit)
 *
 * Pure and total: malformed lines become `problems`, never exceptions.
 */

import type { DeployEntry } from '../../api/deploy/types';

const SHA_RE = /^sha256:([0-9a-f]{64})$/i;
const COMMIT_RE = /^commit:?\s+([0-9a-f]{7,40})$/i;
const DATE_RE = /^\((.+)\)$/;

export interface ParseProblem {
  line: number;
  message: string;
}

export interface ParseResult {
  entries: DeployEntry[];
  problems: ParseProblem[];
}

type Partial = { app: string; version: string; sourceLine: number; commit?: string; sha256?: string; date?: string };

/** Parse a deploy list (block / dated / single-line) into entries + problems. */
export function parseDeployList(text: string): ParseResult {
  const entries: DeployEntry[] = [];
  const problems: ParseProblem[] = [];
  let cur: Partial | null = null;

  const flush = () => {
    if (!cur) return;
    if (cur.sha256) {
      entries.push({
        app: cur.app,
        version: cur.version,
        commit: cur.commit,
        sha256: cur.sha256,
        date: cur.date,
        sourceLine: cur.sourceLine,
      });
    } else {
      problems.push({ line: cur.sourceLine, message: `entry "${cur.app} ${cur.version}" has no sha256` });
    }
    cur = null;
  };

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const lineNo = i + 1;
    if (!line || line.startsWith('#')) return; // blank line / comment

    const sha = line.match(SHA_RE);
    if (sha) {
      if (cur) cur.sha256 = sha[1].toLowerCase();
      else problems.push({ line: lineNo, message: 'sha256 line with no preceding app/version' });
      return;
    }

    const commit = line.match(COMMIT_RE);
    if (commit) {
      if (cur) cur.commit = commit[1].toLowerCase();
      else problems.push({ line: lineNo, message: 'commit line with no preceding app/version' });
      return;
    }

    // Header line — starts a new entry.
    flush();
    const tokens = line.split(/\s+/);
    const [app, version, ...rest] = tokens;
    if (!app || !version) {
      problems.push({ line: lineNo, message: `cannot parse entry header: "${line}"` });
      return;
    }
    cur = { app, version, sourceLine: lineNo };

    const trailer = rest.join(' ');
    if (trailer) {
      const inlineSha = trailer.match(SHA_RE);
      const date = trailer.match(DATE_RE);
      if (inlineSha) cur.sha256 = inlineSha[1].toLowerCase();
      else if (date) cur.date = date[1];
    }
  });

  flush();
  return { entries, problems };
}

export interface ImageShaEntry {
  app?: string;
  version?: string;
  /** Image digest, bare lowercase hex (no "sha256:" prefix). */
  sha256: string;
  sourceLine: number;
}

/**
 * Parse an image-sha list for `checkimageshas`. Each non-empty line must carry a
 * `sha256:<64hex>` token; any tokens before it are taken as app + version. Bare
 * digest lines (just `sha256:...`) are accepted too.
 */
export function parseImageShaList(text: string): { entries: ImageShaEntry[]; problems: ParseProblem[] } {
  const entries: ImageShaEntry[] = [];
  const problems: ParseProblem[] = [];

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const lineNo = i + 1;
    if (!line || line.startsWith('#')) return;

    const tokens = line.split(/\s+/);
    const shaIdx = tokens.findIndex((t) => SHA_RE.test(t));
    if (shaIdx === -1) {
      problems.push({ line: lineNo, message: `no sha256 digest on line: "${line}"` });
      return;
    }
    const sha256 = tokens[shaIdx].replace(/^sha256:/i, '').toLowerCase();
    const before = tokens.slice(0, shaIdx);
    entries.push({ app: before[0], version: before[1], sha256, sourceLine: lineNo });
  });

  return { entries, problems };
}
