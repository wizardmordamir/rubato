/**
 * Check that each image digest in a list actually exists as a Quay tag. Lighter
 * than full verification: it only asks "does this sha256 exist in the app's Quay
 * repo?", resolving the repo through the registry from the line's app label.
 */

import type { QuayClient } from '../../api/quay';
import type { AppConfig } from '../apps';
import { getAppApi } from '../apps';
import { bareDigest } from './collect';
import type { ImageShaEntry } from './parseList';
import { matchAppForLabel } from './verify';

export interface ImageCheckResult {
  app?: string;
  version?: string;
  sha256: string;
  status: 'FOUND' | 'MISSING' | 'SKIPPED';
  /** Tag name carrying the digest, when FOUND. */
  tag?: string;
  /** Why an entry was skipped (no app context / no Quay repo / lookup error). */
  note?: string;
}

/** Resolve each entry's Quay repo and check whether its digest is a live tag. */
export async function checkImageList(
  entries: ImageShaEntry[],
  apps: AppConfig[],
  quay: QuayClient | null,
): Promise<ImageCheckResult[]> {
  return Promise.all(
    entries.map(async (e): Promise<ImageCheckResult> => {
      const base = { app: e.app, version: e.version, sha256: e.sha256 };
      const app = e.app ? matchAppForLabel(e.app, apps) : null;
      const repo = app ? getAppApi(app, 'quay')?.repository : undefined;
      if (!repo) return { ...base, status: 'SKIPPED', note: e.app ? 'no Quay repo for app' : 'no app context' };
      if (!quay) return { ...base, status: 'SKIPPED', note: 'Quay not configured' };
      try {
        const tags = await quay.getTags(repo, { onlyActive: false, limit: 100 });
        const match = tags.find((t) => bareDigest(t.manifest_digest) === e.sha256);
        return match ? { ...base, status: 'FOUND', tag: match.name } : { ...base, status: 'MISSING' };
      } catch (err) {
        return { ...base, status: 'SKIPPED', note: (err as Error).message };
      }
    }),
  );
}
