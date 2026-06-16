/**
 * SQLite CRUD for excel automations + recipes (metadata rows; revision blobs live
 * on disk via storage.ts and the runner). Single-user — no user_id / sharing.
 */

import { randomUUID } from 'node:crypto';
import type { AutomationStep, ExcelAutomation, ExcelRecipe, ExcelSourceKind } from 'cwip/excel-engine/types';
import { getDb } from '../db';
import type { RunnerAutomation } from './runner';

// rubato is single-user; the shared ExcelAutomation type carries a userId, so we
// stamp a stable constant rather than thread a real account through everything.
const LOCAL_USER = 'local';

export interface AutomationRow {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  description: string;
  source_kind: ExcelSourceKind;
  source_name: string;
  steps_json: string;
  original_revision_id: string | null;
  current_revision_id: string | null;
  result_revision_id: string | null;
  archived: number;
}

interface RecipeRow {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  description: string;
  steps_json: string;
}

const now = () => new Date().toISOString();

export const parseSteps = (json: string): AutomationStep[] => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as AutomationStep[]) : [];
  } catch {
    return [];
  }
};

export const mapAutomation = (r: AutomationRow): ExcelAutomation => ({
  id: r.id,
  userId: LOCAL_USER,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  name: r.name,
  description: r.description,
  sourceBinaryId: r.id,
  sourceKind: r.source_kind,
  steps: parseSteps(r.steps_json),
  originalRevisionId: r.original_revision_id ?? undefined,
  currentRevisionId: r.current_revision_id ?? undefined,
  resultRevisionId: r.result_revision_id ?? undefined,
  archived: Boolean(r.archived),
});

export const toRunner = (row: AutomationRow): RunnerAutomation => ({
  id: row.id,
  sourceKind: row.source_kind,
  steps: parseSteps(row.steps_json),
  originalRevisionId: row.original_revision_id,
});

export const getAutomationRow = (id: string): AutomationRow | undefined =>
  getDb().query('SELECT * FROM excel_automations WHERE id = ?').get(id) as AutomationRow | undefined;

export const listAutomations = (): ExcelAutomation[] =>
  (getDb().query('SELECT * FROM excel_automations ORDER BY updated_at DESC').all() as AutomationRow[]).map(
    mapAutomation,
  );

export interface CreateAutomationArgs {
  name: string;
  sourceKind: ExcelSourceKind;
  sourceName: string;
}

export const insertAutomation = (args: CreateAutomationArgs): string => {
  const id = randomUUID();
  const ts = now();
  getDb()
    .query(
      `INSERT INTO excel_automations (
        id, created_at, updated_at, name, description, source_kind, source_name,
        steps_json, original_revision_id, current_revision_id, result_revision_id, archived
      ) VALUES ($id, $now, $now, $name, '', $sourceKind, $sourceName, '[]', NULL, NULL, NULL, 0)`,
    )
    .run({ $id: id, $now: ts, $name: args.name, $sourceKind: args.sourceKind, $sourceName: args.sourceName });
  return id;
};

export const setSteps = (id: string, steps: AutomationStep[]): void => {
  getDb()
    .query('UPDATE excel_automations SET steps_json = $steps, updated_at = $now WHERE id = $id')
    .run({ $id: id, $steps: JSON.stringify(steps), $now: now() });
};

export const setMeta = (id: string, name: string, description: string, archived: boolean): void => {
  getDb()
    .query(
      'UPDATE excel_automations SET name = $name, description = $description, archived = $archived, updated_at = $now WHERE id = $id',
    )
    .run({ $id: id, $name: name, $description: description, $archived: archived ? 1 : 0, $now: now() });
};

// COALESCE on original/current so passing null leaves them; result is set outright.
export const setPointers = (
  id: string,
  pointers: { original?: string | null; current?: string | null; result?: string | null },
): void => {
  getDb()
    .query(
      `UPDATE excel_automations
       SET original_revision_id = COALESCE($original, original_revision_id),
           current_revision_id = COALESCE($current, current_revision_id),
           result_revision_id = $result,
           updated_at = $now
       WHERE id = $id`,
    )
    .run({
      $id: id,
      $original: pointers.original ?? null,
      $current: pointers.current ?? null,
      $result: pointers.result ?? null,
      $now: now(),
    });
};

export const setCurrent = (id: string, current: string): void => {
  getDb()
    .query('UPDATE excel_automations SET current_revision_id = $current, updated_at = $now WHERE id = $id')
    .run({ $id: id, $current: current, $now: now() });
};

export const deleteAutomationRow = (id: string): void => {
  getDb().query('DELETE FROM excel_revisions WHERE automation_id = ?').run(id);
  getDb().query('DELETE FROM excel_automations WHERE id = ?').run(id);
};

// ── Recipes (reusable, file-agnostic step sets) ──────────────────────────────

const mapRecipe = (r: RecipeRow): ExcelRecipe => ({
  id: r.id,
  userId: LOCAL_USER,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  name: r.name,
  description: r.description,
  steps: parseSteps(r.steps_json),
});

export const listRecipes = (): ExcelRecipe[] =>
  (getDb().query('SELECT * FROM excel_recipes ORDER BY updated_at DESC').all() as RecipeRow[]).map(mapRecipe);

export const getRecipe = (id: string): ExcelRecipe | undefined => {
  const row = getDb().query('SELECT * FROM excel_recipes WHERE id = ?').get(id) as RecipeRow | undefined;
  return row ? mapRecipe(row) : undefined;
};

export const createRecipe = (name: string, description: string, steps: AutomationStep[]): ExcelRecipe => {
  const id = randomUUID();
  const ts = now();
  getDb()
    .query(
      `INSERT INTO excel_recipes (id, created_at, updated_at, name, description, steps_json)
       VALUES ($id, $now, $now, $name, $description, $steps)`,
    )
    .run({ $id: id, $now: ts, $name: name, $description: description, $steps: JSON.stringify(steps) });
  return getRecipe(id)!;
};

export const updateRecipe = (
  id: string,
  patch: { name?: string; description?: string; steps?: AutomationStep[] },
): ExcelRecipe | undefined => {
  const existing = getRecipe(id);
  if (!existing) return undefined;
  getDb()
    .query(
      'UPDATE excel_recipes SET name = $name, description = $description, steps_json = $steps, updated_at = $now WHERE id = $id',
    )
    .run({
      $id: id,
      $name: patch.name ?? existing.name,
      $description: patch.description ?? existing.description,
      $steps: JSON.stringify(patch.steps ?? existing.steps),
      $now: now(),
    });
  return getRecipe(id);
};

export const deleteRecipeRow = (id: string): boolean => {
  const res = getDb().query('DELETE FROM excel_recipes WHERE id = ?').run(id);
  return res.changes > 0;
};
