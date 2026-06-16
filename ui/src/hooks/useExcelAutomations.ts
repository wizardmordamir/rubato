import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AutomationStep,
  ExcelAutomation,
  ExcelRecipe,
  ExcelRevision,
  RevisionView,
  RunResult,
  StepResult,
} from "cwip/excel-engine/types";

// ── Self-contained request helpers ────────────────────────────────────────────
// rubato's UI has no shared request layer for this feature, so these mirror the
// conventions in ui/src/api.ts: plain fetch, surface the server's `{ error }`
// (string or `{ message }`) on failure, return parsed JSON.

const errMessage = (data: any): string | undefined =>
  typeof data?.error === "string" ? data.error : data?.error?.message;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(errMessage(await res.json().catch(() => null)) ?? res.statusText);
  return res.json() as Promise<T>;
}

async function sendJson<T>(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(errMessage(await res.json().catch(() => null)) ?? res.statusText);
  return res.json() as Promise<T>;
}

const postJson = <T>(url: string, body?: unknown) => sendJson<T>("POST", url, body);
const patchJson = <T>(url: string, body: unknown) => sendJson<T>("PATCH", url, body);
const del = <T>(url: string) => sendJson<T>("DELETE", url);

async function uploadFile<T>(url: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error(errMessage(await res.json().catch(() => null)) ?? res.statusText);
  return res.json() as Promise<T>;
}

// ── Query keys ────────────────────────────────────────────────────────────────
export const EXCEL_PROJECTS_KEY = ["excel-automations"];
export const projectKey = (id: string) => ["excel-automations", id];
export const revisionsKey = (id: string) => ["excel-automations", id, "revisions"];
export const RECIPES_KEY = ["excel-recipes"];

const BASE = "/api/excel-automations";
const RECIPES_BASE = "/api/excel-recipes";

// ── Reads ─────────────────────────────────────────────────────────────────────
export const useExcelProjectsQuery = () =>
  useQuery({
    queryKey: EXCEL_PROJECTS_KEY,
    queryFn: () => getJson<ExcelAutomation[]>(BASE),
  });

export const useExcelProjectQuery = (id?: string) =>
  useQuery({
    queryKey: projectKey(id ?? ""),
    queryFn: () => getJson<ExcelAutomation>(`${BASE}/${id}`),
    enabled: Boolean(id),
  });

export const useRevisionsQuery = (id?: string) =>
  useQuery({
    queryKey: revisionsKey(id ?? ""),
    queryFn: () => getJson<ExcelRevision[]>(`${BASE}/${id}/revisions`),
    enabled: Boolean(id),
  });

export const useRevisionViewQuery = (id?: string, revisionId?: string, sheet?: string) =>
  useQuery({
    queryKey: ["excel-automations", id ?? "", "revisions", revisionId ?? "", "view", sheet ?? ""],
    queryFn: () =>
      getJson<RevisionView>(
        `${BASE}/${id}/revisions/${revisionId}/view${sheet ? `?sheet=${encodeURIComponent(sheet)}` : ""}`,
      ),
    enabled: Boolean(id && revisionId),
  });

export const useRecipesQuery = () =>
  useQuery({
    queryKey: RECIPES_KEY,
    queryFn: () => getJson<ExcelRecipe[]>(RECIPES_BASE),
  });

// ── Project mutations ───────────────────────────────────────────────────────
export const useUploadProject = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadFile<ExcelAutomation>(`${BASE}/upload`, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: EXCEL_PROJECTS_KEY }),
  });
};

export const useUpdateProject = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; description?: string; archived?: boolean }) =>
      patchJson<ExcelAutomation>(`${BASE}/${id}`, body),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: EXCEL_PROJECTS_KEY });
      qc.invalidateQueries({ queryKey: projectKey(data.id) });
    },
  });
};

export const useSaveSteps = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, steps }: { id: string; steps: AutomationStep[] }) =>
      patchJson<ExcelAutomation>(`${BASE}/${id}/steps`, { steps }),
    onSuccess: (data) => {
      qc.setQueryData(projectKey(data.id), data);
    },
  });
};

export const useDeleteProject = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => del<{ id: string; deleted: boolean }>(`${BASE}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: EXCEL_PROJECTS_KEY }),
  });
};

// ── Run + debug mutations ─────────────────────────────────────────────────────
export const useRunAll = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<RunResult>(`${BASE}/${projectId}/run`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: revisionsKey(projectId) });
      qc.invalidateQueries({ queryKey: projectKey(projectId) });
    },
  });
};

type StepResponse = { result?: StepResult; steps?: StepResult[]; revision: RevisionView };

export const useRunToStep = (projectId: string) =>
  useMutation({
    mutationFn: ({ stepIndex, sheet }: { stepIndex: number; sheet?: string }) =>
      postJson<StepResponse>(
        `${BASE}/${projectId}/run-to/${stepIndex}${sheet ? `?sheet=${encodeURIComponent(sheet)}` : ""}`,
      ),
  });

export const useRunSingleStep = (projectId: string) =>
  useMutation({
    mutationFn: ({ stepIndex, sheet }: { stepIndex: number; sheet?: string }) =>
      postJson<StepResponse>(
        `${BASE}/${projectId}/step/${stepIndex}${sheet ? `?sheet=${encodeURIComponent(sheet)}` : ""}`,
      ),
  });

export const useUndoStep = (projectId: string) =>
  useMutation({
    mutationFn: ({ sheet }: { sheet?: string }) =>
      postJson<{ revision: RevisionView }>(
        `${BASE}/${projectId}/undo${sheet ? `?sheet=${encodeURIComponent(sheet)}` : ""}`,
      ),
  });

export const useManualEdit = (projectId: string) =>
  useMutation({
    mutationFn: (body: {
      stepIndex?: number;
      sheet?: string;
      edits: { row: number; col: number; value: unknown }[];
    }) => postJson<StepResponse>(`${BASE}/${projectId}/manual-edit`, body),
  });

// ── Revision mutations ────────────────────────────────────────────────────────
export const useSelectRevision = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ revisionId }: { revisionId: string }) =>
      postJson<ExcelAutomation>(`${BASE}/${projectId}/revisions/${revisionId}/select`),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKey(projectId) }),
  });
};

export const useSaveSnapshot = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ label }: { label: string }) =>
      postJson<ExcelRevision>(`${BASE}/${projectId}/snapshots`, { label }),
    onSuccess: () => qc.invalidateQueries({ queryKey: revisionsKey(projectId) }),
  });
};

export const useDeleteRevision = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ revisionId }: { revisionId: string }) =>
      del<{ id: string; deleted: boolean }>(`${BASE}/${projectId}/revisions/${revisionId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: revisionsKey(projectId) });
      qc.invalidateQueries({ queryKey: projectKey(projectId) });
    },
  });
};

// ── Recipe mutations ──────────────────────────────────────────────────────────
export const useSaveRecipe = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      description?: string;
      steps?: AutomationStep[];
      fromAutomationId?: string;
    }) => postJson<ExcelRecipe>(RECIPES_BASE, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: RECIPES_KEY }),
  });
};

export const useDeleteRecipe = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => del<{ id: string; deleted: boolean }>(`${RECIPES_BASE}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: RECIPES_KEY }),
  });
};

// Apply a saved automation's steps to a target file. The target is part of the
// mutation variables (not baked into the hook) so the /excel library can apply to a
// file chosen per-row, while the builder passes its own open project.
export const useApplyRecipe = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, recipeId }: { projectId: string; recipeId: string }) =>
      postJson<{ id: string; steps: AutomationStep[] }>(`${BASE}/${projectId}/apply-recipe/${recipeId}`),
    onSuccess: (_data, { projectId }) => qc.invalidateQueries({ queryKey: projectKey(projectId) }),
  });
};

// Binary download URLs (plain GET).
export const originalDownloadUrl = (id: string) => `${BASE}/${id}/original/download`;
export const resultDownloadUrl = (id: string) => `${BASE}/${id}/result/download`;
export const revisionDownloadUrl = (id: string, revId: string) => `${BASE}/${id}/revisions/${revId}/download`;
