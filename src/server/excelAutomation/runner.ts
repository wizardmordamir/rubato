/**
 * Excel Automations runner — the app-specific persistence around the pure
 * cwip/excel-engine. It chains revisions: each step loads the parent revision's
 * workbook, applies one step via the engine, and persists the result as a new
 * revision (bytes on disk, metadata in SQLite). Mirrors cursedalchemy's runner
 * but single-user + local-disk (no user_id / MediaStore / S3).
 */

import { randomUUID } from 'node:crypto';
import {
  applyStepToWorkbook,
  buildRevisionView,
  type HiddenMask,
  loadWorkbook,
  workbookToXlsxBytes,
} from 'cwip/excel-engine';
import type {
  AutomationStep,
  ExcelRevision,
  ExcelSourceKind,
  RevisionKind,
  RevisionView,
  RunResult,
  StepResult,
} from 'cwip/excel-engine/types';
import type ExcelJS from 'exceljs';
import { getDb } from '../db';
import { readRevisionBytes as readBlob, writeRevisionBytes } from './storage';

// The slice of an automation the runner needs (handlers pass the loaded row).
export interface RunnerAutomation {
  id: string;
  sourceKind: ExcelSourceKind;
  steps: AutomationStep[];
  originalRevisionId?: string | null;
}

interface RevisionRow {
  id: string;
  automation_id: string;
  created_at: string;
  updated_at: string;
  parent_revision_id: string | null;
  seq: number;
  label: string;
  kind: RevisionKind;
  produced_by_step_index: number | null;
  produced_by_step_id: string | null;
  byte_size: number;
  status: 'ok' | 'error';
  hidden_mask_json: string;
  step_result_json: string;
}

const now = () => new Date().toISOString();

const safeParse = <T>(json: string): T | null => {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
};

const parseMask = (json: string): HiddenMask => safeParse<HiddenMask>(json) ?? {};

export const getRevisionRow = (revisionId: string): RevisionRow | undefined =>
  getDb().query('SELECT * FROM excel_revisions WHERE id = ?').get(revisionId) as RevisionRow | undefined;

export const listRevisions = (automationId: string): ExcelRevision[] =>
  (
    getDb()
      .query('SELECT * FROM excel_revisions WHERE automation_id = ? ORDER BY seq DESC')
      .all(automationId) as RevisionRow[]
  ).map(mapRevision);

export const deleteRevision = (revisionId: string): void => {
  getDb().query('DELETE FROM excel_revisions WHERE id = ?').run(revisionId);
};

export const mapRevision = (r: RevisionRow): ExcelRevision => ({
  id: r.id,
  automationId: r.automation_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  parentRevisionId: r.parent_revision_id ?? undefined,
  seq: r.seq,
  label: r.label,
  kind: r.kind,
  producedByStepIndex: r.produced_by_step_index ?? undefined,
  producedByStepId: r.produced_by_step_id ?? undefined,
  byteSize: r.byte_size,
  status: r.status,
  stepResult: safeParse<StepResult>(r.step_result_json) ?? undefined,
});

// Load a revision's workbook bytes (from disk) + its hidden mask.
export const loadRevisionWorkbook = async (
  revisionId: string,
): Promise<{ wb: ExcelJS.Workbook; mask: HiddenMask; row: RevisionRow }> => {
  const row = getRevisionRow(revisionId);
  if (!row) throw new Error('Revision not found');
  const bytes = await readBlob(row.automation_id, row.id);
  if (!bytes) throw new Error('Revision bytes missing from storage');
  const wb = await loadWorkbook(bytes, 'xlsx');
  return { wb, mask: parseMask(row.hidden_mask_json), row };
};

// Read a revision's raw xlsx bytes (for download/export).
export const readRevisionBytes = async (revisionId: string): Promise<Uint8Array | null> => {
  const row = getRevisionRow(revisionId);
  if (!row) return null;
  return readBlob(row.automation_id, row.id);
};

interface PersistArgs {
  automation: RunnerAutomation;
  wb: ExcelJS.Workbook;
  mask: HiddenMask;
  parentRevisionId: string | null;
  kind: RevisionKind;
  label?: string;
  stepIndex?: number | null;
  stepId?: string | null;
  status?: 'ok' | 'error';
  stepResult?: StepResult | null;
}

// Serialize a workbook to a NEW revision (bytes → disk, metadata → row).
export const persistRevision = async (args: PersistArgs): Promise<ExcelRevision> => {
  const { automation, wb, mask } = args;
  const bytes = await workbookToXlsxBytes(wb);
  const id = randomUUID();
  const ts = now();
  const byteSize = await writeRevisionBytes(automation.id, id, bytes);
  const seq = (
    getDb()
      .query('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM excel_revisions WHERE automation_id = ?')
      .get(automation.id) as { next: number }
  ).next;
  getDb()
    .query(
      `INSERT INTO excel_revisions (
        id, automation_id, created_at, updated_at, parent_revision_id, seq,
        label, kind, produced_by_step_index, produced_by_step_id,
        byte_size, status, hidden_mask_json, step_result_json
      ) VALUES (
        $id, $automationId, $createdAt, $updatedAt, $parentRevisionId, $seq,
        $label, $kind, $producedByStepIndex, $producedByStepId,
        $byteSize, $status, $hiddenMaskJson, $stepResultJson
      )`,
    )
    .run({
      $id: id,
      $automationId: automation.id,
      $createdAt: ts,
      $updatedAt: ts,
      $parentRevisionId: args.parentRevisionId,
      $seq: seq,
      $label: args.label ?? '',
      $kind: args.kind,
      $producedByStepIndex: args.stepIndex ?? null,
      $producedByStepId: args.stepId ?? null,
      $byteSize: byteSize,
      $status: args.status ?? 'ok',
      $hiddenMaskJson: JSON.stringify(mask),
      $stepResultJson: JSON.stringify(args.stepResult ?? {}),
    });
  return mapRevision(getRevisionRow(id)!);
};

// Seed the immutable original as revision 0 (a working copy of the source bytes,
// stored as xlsx so every later revision is uniform).
export const seedOriginalRevision = async (
  automation: RunnerAutomation,
  sourceBytes: Uint8Array,
): Promise<ExcelRevision> => {
  const wb = await loadWorkbook(sourceBytes, automation.sourceKind);
  return persistRevision({
    automation,
    wb,
    mask: {},
    parentRevisionId: null,
    kind: 'original',
    label: 'Original',
  });
};

const enabledSteps = (steps: AutomationStep[]): { step: AutomationStep; index: number }[] =>
  steps.map((step, index) => ({ step, index })).filter(({ step }) => step.enabled !== false);

// Apply ONE step from a given revision, producing a child revision + StepResult.
export const applyOneStep = async (
  automation: RunnerAutomation,
  fromRevisionId: string,
  stepIndex: number,
  kind: RevisionKind = 'step',
): Promise<{ revision: ExcelRevision; result: StepResult }> => {
  const step = automation.steps[stepIndex];
  if (!step) throw new Error(`No step at index ${stepIndex}`);
  const { wb, mask } = await loadRevisionWorkbook(fromRevisionId);
  const startedAt = now();
  const t0 = performance.now();
  let result: StepResult;
  try {
    const outcome = applyStepToWorkbook(wb, mask, step);
    result = {
      stepId: step.id,
      stepIndex,
      type: step.type,
      status: 'ok',
      rowsAffected: outcome.rowsAffected,
      colsAffected: outcome.colsAffected,
      sheetsAffected: outcome.sheetsAffected,
      startedAt,
      finishedAt: now(),
      durationMs: Math.round(performance.now() - t0),
    };
  } catch (err) {
    result = {
      stepId: step.id,
      stepIndex,
      type: step.type,
      status: 'error',
      rowsAffected: 0,
      colsAffected: 0,
      sheetsAffected: 0,
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      finishedAt: now(),
      durationMs: Math.round(performance.now() - t0),
    };
    // Don't persist a broken workbook; surface the error against the source revision.
    return { revision: mapRevision(getRevisionRow(fromRevisionId)!), result };
  }
  const revision = await persistRevision({
    automation,
    wb,
    mask,
    parentRevisionId: fromRevisionId,
    kind,
    stepIndex,
    stepId: step.id,
    stepResult: result,
    label: kind === 'manual' ? 'Manual edit' : '',
  });
  result.producedRevisionId = revision.id;
  return { revision, result };
};

// Fold all enabled steps from the original revision, producing one revision per
// step. The terminal revision is re-persisted as the auto-saved RESULT.
export const runAllSteps = async (automation: RunnerAutomation, fromRevisionId?: string): Promise<RunResult> => {
  const startId = fromRevisionId ?? automation.originalRevisionId;
  if (!startId) throw new Error('Automation has no original revision to run from');
  let current = startId;
  const results: StepResult[] = [];
  for (const { index } of enabledSteps(automation.steps)) {
    const { revision, result } = await applyOneStep(automation, current, index, 'step');
    results.push(result);
    if (result.status === 'error') break;
    current = revision.id;
  }
  const { wb, mask } = await loadRevisionWorkbook(current);
  const resultRevision = await persistRevision({
    automation,
    wb,
    mask,
    parentRevisionId: current,
    kind: 'result',
    label: 'Result',
  });
  return {
    automationId: automation.id,
    steps: results,
    finalRevisionId: current,
    resultRevisionId: resultRevision.id,
  };
};

// Debug: walk enabled steps up to and including `targetIndex` from the original.
export const runToStep = async (
  automation: RunnerAutomation,
  targetIndex: number,
  fromRevisionId?: string,
): Promise<{ steps: StepResult[]; revisionId: string }> => {
  const startId = fromRevisionId ?? automation.originalRevisionId;
  if (!startId) throw new Error('Automation has no original revision to run from');
  let current = startId;
  const results: StepResult[] = [];
  for (const { index } of enabledSteps(automation.steps)) {
    if (index > targetIndex) break;
    const { revision, result } = await applyOneStep(automation, current, index, 'step');
    results.push(result);
    if (result.status === 'error') break;
    current = revision.id;
  }
  return { steps: results, revisionId: current };
};

// Build a grid view for a revision (optionally a specific sheet).
export const viewRevision = async (
  revisionId: string,
  activeSheet?: string,
  maxRows?: number,
): Promise<RevisionView> => {
  const { wb, mask } = await loadRevisionWorkbook(revisionId);
  return buildRevisionView(wb, mask, { revisionId, activeSheet, maxRows });
};
