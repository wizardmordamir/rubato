/**
 * Run an Excel Automation's steps over a file in a pipeline run dir — the headless
 * counterpart to the interactive builder. Reads CSV/xlsx via the cwip workbook
 * engine, applies the automation's enabled steps, then writes CSV/xlsx back to the
 * run dir (for the next stage) or the output dir. This is what a `kind:'excel'`
 * pipeline stage runs; the transform itself lives on the referenced automation.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import {
  applyStepToWorkbook,
  type HiddenMask,
  loadWorkbook,
  workbookToCsvBytes,
  workbookToXlsxBytes,
} from 'cwip/excel-engine';
import type { AutomationStep, ExcelSourceKind } from 'cwip/excel-engine/types';
import { OUTPUTS_DIR } from '../../lib/config';
import { interpolate } from '../../lib/interpolate';
import type { ExcelStageIO } from '../../shared/pipeline';

export interface ExcelStageInput {
  dir: string;
  vars: Record<string, string>;
  log?: (chunk: string) => void;
}

export interface ExcelStageResult {
  /** Visible data-row count after the transform (handed forward as a var). */
  rows: number;
  /** Output filename (relative), handed forward as a var. */
  outFile: string;
  /** Absolute path written. */
  outPath: string;
}

/** The minimal automation shape a headless run needs: a name + its steps. */
export interface ExcelStageAutomation {
  name: string;
  steps: AutomationStep[];
}

const fill = (template: string, vars: Record<string, string>, dir: string): string =>
  interpolate(template, { scraped: {}, vars, dir }).value || template;

const kindOf = (path: string): ExcelSourceKind => (extname(path).toLowerCase() === '.xlsx' ? 'xlsx' : 'csv');

/** Visible (non-hidden) rows in the first sheet, less the header row. */
const visibleDataRows = (wb: Awaited<ReturnType<typeof loadWorkbook>>): number => {
  const ws = wb.worksheets[0];
  if (!ws) return 0;
  let visible = 0;
  for (let r = 1; r <= ws.rowCount; r++) if (!ws.getRow(r).hidden) visible++;
  return Math.max(0, visible - 1);
};

/** Run an excel automation against the run dir; returns row count + output path. */
export async function runAutomationOverFile(
  automation: ExcelStageAutomation,
  io: ExcelStageIO,
  input: ExcelStageInput,
): Promise<ExcelStageResult> {
  const inName = fill(io.input, input.vars, input.dir);
  const inPath = isAbsolute(inName) ? inName : resolve(input.dir, inName);
  const bytes = new Uint8Array(await Bun.file(inPath).arrayBuffer());
  const wb = await loadWorkbook(bytes, kindOf(inPath));

  // Honor a requested worksheet by dropping the others (the engine acts on the first).
  if (io.sheet) {
    const keep = wb.worksheets.find((w: { name: string }) => w.name === io.sheet);
    if (!keep) throw new Error(`sheet not found: ${io.sheet}`);
    for (const w of [...wb.worksheets] as Array<{ id: number }>) if (w.id !== keep.id) wb.removeWorksheet(w.id);
  }

  const mask: HiddenMask = {};
  for (const step of automation.steps) {
    if (step.enabled === false) continue;
    applyStepToWorkbook(wb, mask, step);
  }

  const outName = fill(io.output.file, input.vars, input.dir);
  const base = io.output.to === 'output' ? OUTPUTS_DIR : input.dir;
  const outPath = isAbsolute(outName) ? outName : resolve(base, outName);
  const format = io.output.format ?? (extname(outName).toLowerCase() === '.xlsx' ? 'xlsx' : 'csv');
  await mkdir(dirname(outPath), { recursive: true });
  const outBytes = format === 'xlsx' ? await workbookToXlsxBytes(wb) : workbookToCsvBytes(wb);
  await Bun.write(outPath, outBytes);

  const rows = visibleDataRows(wb);
  input.log?.(`excel "${automation.name}": ${rows} row(s) → ${outName}\n`);
  return { rows, outFile: outName, outPath };
}
