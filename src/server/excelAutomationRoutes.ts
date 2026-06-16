/**
 * Excel Automations API — upload a workbook, build a list of declarative steps,
 * run them through the cwip/excel-engine step engine, and walk the resulting
 * revision chain (run-all / debug-step / undo / manual-edit / snapshots), plus
 * reusable recipes. Single-user, local — no auth/sharing (cursedalchemy's
 * multi-user sibling adds those). Mirrors that app's endpoint contract so the
 * ported UI is identical.
 *
 *   POST   /api/excel-automations/upload                          (multipart "file")
 *   GET    /api/excel-automations                                 → ExcelAutomation[]
 *   GET    /api/excel-automations/:id
 *   PATCH  /api/excel-automations/:id                             { name?, description?, archived? }
 *   PATCH  /api/excel-automations/:id/steps                       { steps }
 *   DELETE /api/excel-automations/:id
 *   POST   /api/excel-automations/:id/run                         → RunResult
 *   POST   /api/excel-automations/:id/run-to/:stepIndex           → { steps, revision }
 *   POST   /api/excel-automations/:id/step/:stepIndex             → { result, revision }
 *   POST   /api/excel-automations/:id/undo                        → { revision }
 *   POST   /api/excel-automations/:id/manual-edit                 { edits, sheet?, stepIndex? }
 *   GET    /api/excel-automations/:id/revisions                   → ExcelRevision[]
 *   GET    /api/excel-automations/:id/revisions/:rid/view?sheet=  → RevisionView
 *   POST   /api/excel-automations/:id/revisions/:rid/select
 *   DELETE /api/excel-automations/:id/revisions/:rid
 *   GET    /api/excel-automations/:id/revisions/:rid/download     (raw xlsx)
 *   POST   /api/excel-automations/:id/snapshots                   { label }
 *   GET    /api/excel-automations/:id/original/download           (raw original)
 *   GET    /api/excel-automations/:id/result/download             (raw xlsx)
 *   POST   /api/excel-automations/:id/apply-recipe/:recipeId      → { id, steps }
 *   GET/POST/PATCH/DELETE /api/excel-recipes[/:id]
 */

import { randomUUID } from 'node:crypto';
import type { AutomationStep, ExcelSourceKind } from 'cwip/excel-engine/types';
import {
  applyOneStep,
  deleteRevision,
  getRevisionRow,
  listRevisions,
  loadRevisionWorkbook,
  persistRevision,
  readRevisionBytes,
  runAllSteps,
  runToStep,
  seedOriginalRevision,
  viewRevision,
} from './excelAutomation/runner';
import { readSourceBytes, removeAutomationDir, removeRevisionFile, writeSourceBytes } from './excelAutomation/storage';
import {
  type AutomationRow,
  createRecipe,
  deleteAutomationRow,
  deleteRecipeRow,
  getAutomationRow,
  getRecipe,
  insertAutomation,
  listAutomations,
  listRecipes,
  mapAutomation,
  parseSteps,
  setCurrent,
  setMeta,
  setPointers,
  setSteps,
  toRunner,
  updateRecipe,
} from './excelAutomation/store';
import { json, jsonError, readJsonBody } from './http';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const sourceKindFor = (name: string, type: string): ExcelSourceKind =>
  name.toLowerCase().endsWith('.csv') || type === 'text/csv' ? 'csv' : 'xlsx';

const sourceExt = (kind: ExcelSourceKind): string => (kind === 'csv' ? 'csv' : 'xlsx');

// Stream raw bytes as a download (the original / a revision / the result). Plain
// GET so it works without the JSON envelope.
const downloadResponse = (bytes: Uint8Array, filename: string, mime: string): Response =>
  // Bun's Response accepts a Uint8Array body; the DOM lib's BodyInit is stricter.
  new Response(bytes as BodyInit, {
    headers: {
      'content-type': mime,
      'content-disposition': `attachment; filename="${filename.replace(/[^\w.-]+/g, '_')}"`,
    },
  });

async function uploadAutomation(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("multipart form data with a 'file' field required", 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return jsonError("'file' field required", 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sourceKindFor(file.name, file.type);
  const fileName = file.name || `upload.${sourceExt(kind)}`;
  const baseName = fileName.replace(/\.[^.]+$/, '') || 'Untitled';

  const id = insertAutomation({ name: baseName, sourceKind: kind, sourceName: fileName });
  // Keep the immutable original verbatim (for "download original"), then seed the
  // working "original" revision (stored as xlsx so the chain is uniform).
  await writeSourceBytes(id, sourceExt(kind), bytes);
  const original = await seedOriginalRevision({ id, sourceKind: kind, steps: [], originalRevisionId: null }, bytes);
  setPointers(id, { original: original.id, current: original.id, result: null });
  return json(mapAutomation(getAutomationRow(id)!), 201);
}

// ── per-automation sub-routes ────────────────────────────────────────────────

async function handleAutomation(row: AutomationRow, segs: string[], req: Request): Promise<Response> {
  const id = row.id;
  const sub = segs[1];
  const method = req.method;
  const url = new URL(req.url);
  const sheet = url.searchParams.get('sheet') ?? undefined;

  // /:id
  if (!sub) {
    if (method === 'GET') return json(mapAutomation(row));
    if (method === 'PATCH') {
      const b = (await readJsonBody<{ name?: string; description?: string; archived?: boolean }>(req)) ?? {};
      setMeta(
        id,
        b.name ?? row.name,
        b.description ?? row.description,
        b.archived != null ? Boolean(b.archived) : Boolean(row.archived),
      );
      return json(mapAutomation(getAutomationRow(id)!));
    }
    if (method === 'DELETE') {
      deleteAutomationRow(id);
      void removeAutomationDir(id).catch(() => undefined);
      return json({ id, deleted: true });
    }
    return jsonError('use GET, PATCH or DELETE', 405);
  }

  // /:id/steps
  if (sub === 'steps') {
    if (method !== 'PATCH') return jsonError('use PATCH', 405);
    const b = await readJsonBody<{ steps?: AutomationStep[] }>(req);
    setSteps(id, Array.isArray(b?.steps) ? b.steps : []);
    return json(mapAutomation(getAutomationRow(id)!));
  }

  // /:id/run
  if (sub === 'run') {
    if (method !== 'POST') return jsonError('use POST', 405);
    const result = await runAllSteps(toRunner(row));
    setPointers(id, { current: result.finalRevisionId, result: result.resultRevisionId ?? null });
    return json(result);
  }

  // /:id/run-to/:stepIndex
  if (sub === 'run-to') {
    if (method !== 'POST') return jsonError('use POST', 405);
    const target = Number(segs[2]);
    if (!Number.isFinite(target)) return jsonError('invalid step index', 400);
    const { steps, revisionId } = await runToStep(toRunner(row), target);
    setCurrent(id, revisionId);
    return json({ steps, revision: await viewRevision(revisionId, sheet) });
  }

  // /:id/step/:stepIndex
  if (sub === 'step') {
    if (method !== 'POST') return jsonError('use POST', 405);
    if (!row.current_revision_id) return jsonError('no current revision', 404);
    const stepIndex = Number(segs[2]);
    if (!Number.isFinite(stepIndex)) return jsonError('invalid step index', 400);
    const { revision, result } = await applyOneStep(toRunner(row), row.current_revision_id, stepIndex, 'step');
    if (result.status === 'ok') setCurrent(id, revision.id);
    const view = await viewRevision(result.status === 'ok' ? revision.id : row.current_revision_id, sheet);
    return json({ result, revision: view });
  }

  // /:id/undo
  if (sub === 'undo') {
    if (method !== 'POST') return jsonError('use POST', 405);
    if (!row.current_revision_id) return jsonError('no current revision', 404);
    const rev = getRevisionRow(row.current_revision_id);
    const parent = rev?.parent_revision_id ?? row.original_revision_id;
    if (!parent) return jsonError('nothing to undo', 404);
    setCurrent(id, parent);
    return json({ revision: await viewRevision(parent, sheet) });
  }

  // /:id/manual-edit
  if (sub === 'manual-edit') {
    if (method !== 'POST') return jsonError('use POST', 405);
    if (!row.current_revision_id) return jsonError('no current revision', 404);
    const b =
      (await readJsonBody<{
        edits?: { row: number; col: number; value: unknown }[];
        sheet?: string;
        stepIndex?: number;
      }>(req)) ?? {};
    const edits = Array.isArray(b.edits) ? b.edits : [];
    const steps = parseSteps(row.steps_json);
    const stepIndex = b.stepIndex;
    const targeted = stepIndex != null && steps[stepIndex]?.type === 'manualEdit';
    const sheetName = b.sheet || (targeted ? ((steps[stepIndex] as { sheet?: string }).sheet ?? '') : '');
    // Record into the targeted manualEdit step so a full re-run reproduces them.
    if (targeted) {
      const step = steps[stepIndex] as { edits?: unknown[]; sheet?: string };
      step.edits = [...(step.edits ?? []), ...edits];
      step.sheet = step.sheet || sheetName;
      setSteps(id, steps);
    }
    // Apply to the current revision as a one-off manualEdit step → manual revision.
    const manualStep = {
      id: randomUUID(),
      enabled: true,
      type: 'manualEdit',
      sheet: sheetName,
      edits,
    } as AutomationStep;
    const { revision, result } = await applyOneStep(
      { ...toRunner(row), steps: [manualStep] },
      row.current_revision_id,
      0,
      'manual',
    );
    if (result.status === 'ok') setCurrent(id, revision.id);
    const view = await viewRevision(
      result.status === 'ok' ? revision.id : row.current_revision_id,
      sheetName || undefined,
    );
    return json({ result, revision: view });
  }

  // /:id/snapshots
  if (sub === 'snapshots') {
    if (method !== 'POST') return jsonError('use POST', 405);
    if (!row.current_revision_id) return jsonError('no current revision', 404);
    const b = (await readJsonBody<{ label?: string }>(req)) ?? {};
    const { wb, mask } = await loadRevisionWorkbook(row.current_revision_id);
    const snapshot = await persistRevision({
      automation: toRunner(row),
      wb,
      mask,
      parentRevisionId: row.current_revision_id,
      kind: 'manual',
      label: b.label || 'Snapshot',
    });
    return json(snapshot);
  }

  // /:id/revisions[...]
  if (sub === 'revisions') {
    const rid = segs[2];
    if (!rid) {
      if (method !== 'GET') return jsonError('use GET', 405);
      return json(listRevisions(id));
    }
    const action = segs[3];
    const rev = getRevisionRow(rid);
    if (!rev || rev.automation_id !== id) return jsonError('revision not found', 404);
    if (action === 'view') {
      if (method !== 'GET') return jsonError('use GET', 405);
      return json(await viewRevision(rid, sheet));
    }
    if (action === 'select') {
      if (method !== 'POST') return jsonError('use POST', 405);
      setCurrent(id, rid);
      return json(mapAutomation(getAutomationRow(id)!));
    }
    if (action === 'download') {
      if (method !== 'GET') return jsonError('use GET', 405);
      const bytes = await readRevisionBytes(rid);
      if (!bytes) return jsonError('revision bytes missing', 404);
      return downloadResponse(bytes, `${row.name}-revision.xlsx`, XLSX_MIME);
    }
    if (!action) {
      if (method !== 'DELETE') return jsonError('use DELETE', 405);
      if (rev.kind === 'original') return jsonError('cannot delete the original', 400);
      deleteRevision(rid);
      void removeRevisionFile(id, rid).catch(() => undefined);
      const result = row.result_revision_id === rid ? null : row.result_revision_id;
      const current = row.current_revision_id === rid ? row.original_revision_id : row.current_revision_id;
      setPointers(id, { current, result });
      return json({ id: rid, deleted: true });
    }
    return jsonError('not found', 404);
  }

  // /:id/original/download · /:id/result/download
  if (sub === 'original' && segs[2] === 'download') {
    if (method !== 'GET') return jsonError('use GET', 405);
    const ext = sourceExt(row.source_kind);
    const bytes = await readSourceBytes(id, ext);
    if (!bytes) return jsonError('original bytes missing', 404);
    const mime = row.source_kind === 'csv' ? 'text/csv' : XLSX_MIME;
    return downloadResponse(bytes, row.source_name || `original.${ext}`, mime);
  }
  if (sub === 'result' && segs[2] === 'download') {
    if (method !== 'GET') return jsonError('use GET', 405);
    if (!row.result_revision_id) return jsonError('no result yet', 404);
    const bytes = await readRevisionBytes(row.result_revision_id);
    if (!bytes) return jsonError('result bytes missing', 404);
    return downloadResponse(bytes, `${row.name}-result.xlsx`, XLSX_MIME);
  }

  // /:id/apply-recipe/:recipeId
  if (sub === 'apply-recipe') {
    if (method !== 'POST') return jsonError('use POST', 405);
    const recipe = getRecipe(segs[2] ?? '');
    if (!recipe) return jsonError('recipe not found', 404);
    // Re-id the steps so they never collide with existing step ids.
    const steps = recipe.steps.map((s) => ({ ...s, id: randomUUID() }));
    setSteps(id, steps);
    return json({ id, steps });
  }

  return jsonError('not found', 404);
}

// ── recipes ──────────────────────────────────────────────────────────────────

async function handleRecipes(pathname: string, req: Request): Promise<Response> {
  const rest = pathname.slice('/api/excel-recipes'.length);
  if (rest === '' || rest === '/') {
    if (req.method === 'GET') return json(listRecipes());
    if (req.method === 'POST') {
      const b = await readJsonBody<{
        name?: string;
        description?: string;
        steps?: AutomationStep[];
        fromAutomationId?: string;
      }>(req);
      if (!b?.name?.trim()) return jsonError('name required', 400);
      // Clone from an automation's current step list when asked.
      let steps = Array.isArray(b.steps) ? b.steps : [];
      if (b.fromAutomationId) {
        const src = getAutomationRow(b.fromAutomationId);
        if (src) steps = parseSteps(src.steps_json);
      }
      return json(createRecipe(b.name.trim(), b.description ?? '', steps), 201);
    }
    return jsonError('use GET or POST', 405);
  }
  const recipeId = decodeURIComponent(rest.slice(1));
  if (req.method === 'PATCH') {
    const b = (await readJsonBody<{ name?: string; description?: string; steps?: AutomationStep[] }>(req)) ?? {};
    const updated = updateRecipe(recipeId, b);
    return updated ? json(updated) : jsonError('not found', 404);
  }
  if (req.method === 'DELETE') return json({ id: recipeId, deleted: deleteRecipeRow(recipeId) });
  return jsonError('use PATCH or DELETE', 405);
}

export async function handleExcelAutomationApi(pathname: string, req: Request): Promise<Response> {
  if (pathname === '/api/excel-recipes' || pathname.startsWith('/api/excel-recipes/')) {
    return handleRecipes(pathname, req);
  }
  const rest = pathname.slice('/api/excel-automations'.length);
  if (rest === '' || rest === '/') {
    if (req.method === 'GET') return json(listAutomations());
    return jsonError('use GET', 405);
  }
  if (rest === '/upload') {
    if (req.method !== 'POST') return jsonError('use POST', 405);
    return uploadAutomation(req);
  }
  const segs = rest.split('/').filter(Boolean).map(decodeURIComponent);
  const row = getAutomationRow(segs[0]);
  if (!row) return jsonError('not found', 404);
  return handleAutomation(row, segs, req);
}
