/**
 * On-disk cleanup for automation runs. Runs persist a per-step timeline (HTML +
 * screenshots) under the output dir, loose per-step shots under
 * ~/.rubato/automation-shots, and a per-run working dir under
 * ~/.rubato/pipeline-runs — all named `<automationId>-<startedAt>`. Nothing prunes
 * them today, so they pile up; these helpers remove a run's footprint on demand
 * (the DB row is deleted separately in db.ts). Best-effort: missing paths are fine.
 */

import { readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AutomationRunRecord } from '../shared/automation';
import { RUBATO_HOME } from './config';
import { resolveOutputDir } from './runStore';

const SHOTS_DIR = resolve(RUBATO_HOME, 'automation-shots');
const RUNS_DIR = resolve(RUBATO_HOME, 'pipeline-runs');

type RunLocator = Pick<AutomationRunRecord, 'automationId' | 'startedAt'>;

/** Remove every on-disk artifact for one run. Runs recorded before automationId
 *  was tracked can't be located, so only their DB row (handled elsewhere) goes. */
export async function deleteRunArtifacts(run: RunLocator): Promise<void> {
  if (!run.automationId) return;
  const stem = `${run.automationId}-${run.startedAt}`;
  const outputDir = await resolveOutputDir().catch(() => null);
  const dirs = [outputDir ? resolve(outputDir, 'automation-runs', stem) : null, resolve(RUNS_DIR, stem)].filter(
    (d): d is string => d != null,
  );
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  // Per-step shots are loose files named `<stem>-<index>.png` in SHOTS_DIR.
  await readdir(SHOTS_DIR)
    .then((names) =>
      Promise.all(
        names
          .filter((n) => n.startsWith(`${stem}-`))
          .map((n) => rm(resolve(SHOTS_DIR, n), { force: true }).catch(() => {})),
      ),
    )
    .catch(() => {});
}

/** Remove the on-disk artifacts for many runs (sequential; best-effort). */
export async function deleteManyRunArtifacts(runs: RunLocator[]): Promise<void> {
  for (const r of runs) await deleteRunArtifacts(r);
}
