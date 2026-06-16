/**
 * Read-only access to the diagnostic artifacts written under
 * `<outputDir>/diagnostics/` (see `src/lib/diagnostics`). Powers the admin
 * "Diagnostics" panel: a parsed summary list (status/activity/error, filterable),
 * plus on-demand read of a single report or its companion JSONL log.
 *
 * Everything goes through `files.ts`, which scopes all paths to the output dir and
 * enforces the traversal / secret-pattern / symlink guards — so this never widens
 * the read surface beyond what the Files tab already exposes.
 */

import type { DiagnosticReport } from '../lib/diagnostics';
import type { DiagnosticSummary, OutputFile } from '../shared/types';
import { type FileContent, listOutputFiles, readOutputFile } from './files';

const DIAG_DIR = 'diagnostics/';

/** A diagnostic artifact lives under the diagnostics/ subdir of the output dir. */
function inDiagnostics(f: OutputFile): boolean {
  return f.path.startsWith(DIAG_DIR);
}

/**
 * Summaries of every diagnostic report, newest first. Each `.report.json` is
 * parsed for its overview fields; a malformed/oversized report degrades to a
 * minimal summary rather than dropping out of the list.
 */
export async function listDiagnostics(): Promise<DiagnosticSummary[]> {
  const files = (await listOutputFiles()).filter(inDiagnostics);
  const logs = new Set(files.filter((f) => f.path.endsWith('.log.jsonl')).map((f) => f.path));
  const reports = files.filter((f) => f.path.endsWith('.report.json'));

  const out: DiagnosticSummary[] = [];
  for (const f of reports) {
    const logPath = f.path.replace(/\.report\.json$/, '.log.jsonl');
    const base: DiagnosticSummary = {
      path: f.path,
      logPath: logs.has(logPath) ? logPath : undefined,
      activity: f.name.replace(/\.report\.json$/, ''),
      status: 'ok',
      correlationId: '',
      startedAt: new Date(f.modifiedAt).toISOString(),
      durationMs: 0,
      counts: { steps: 0, warnings: 0, errors: 0, shapeMismatches: 0 },
      modifiedAt: f.modifiedAt,
      size: f.size,
    };
    const read = await readOutputFile(f.path);
    if (read.ok) {
      try {
        const r = JSON.parse(read.content) as DiagnosticReport;
        out.push({
          ...base,
          activity: r.activity ?? base.activity,
          intent: r.intent,
          status: r.status ?? 'ok',
          correlationId: r.correlationId ?? '',
          startedAt: r.startedAt ?? base.startedAt,
          durationMs: r.durationMs ?? 0,
          errorClass: r.error?.classification,
          errorMessage: r.error?.message,
          counts: r.counts ?? base.counts,
        });
        continue;
      } catch {
        // not valid JSON — fall through to the minimal summary
      }
    }
    out.push(base);
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

/** Read one diagnostic artifact (report or log), scoped to the diagnostics dir. */
export async function readDiagnostic(path: string): Promise<FileContent> {
  if (!path.startsWith(DIAG_DIR)) return { ok: false, status: 403, error: 'not a diagnostic path' };
  return readOutputFile(path);
}
